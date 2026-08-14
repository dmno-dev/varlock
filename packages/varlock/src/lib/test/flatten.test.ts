import {
  describe, test, expect, beforeEach, afterEach, vi,
} from 'vitest';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import outdent from 'outdent';
import { flattenEnvFiles, FlattenError } from '../flatten';
import { EnvGraph, DirectoryDataSource } from '../../env-graph';
import { downloadPluginToCache } from '../../env-graph/lib/plugins';

// vendoring downloads plugins from npm - stub the download so tests stay offline.
// The stub materializes a fake extracted plugin package that flatten then copies.
vi.mock('../../env-graph/lib/plugins', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../env-graph/lib/plugins')>();
  return { ...actual, downloadPluginToCache: vi.fn() };
});

let baseDir: string;
let workspaceDir: string;

beforeEach(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'varlock-flatten-test-'));
  workspaceDir = path.join(baseDir, 'repo');
  await fs.mkdir(workspaceDir);
});
afterEach(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

async function writeTree(files: Record<string, string>, rootDir?: string) {
  for (const [relPath, contents] of Object.entries(files)) {
    const fullPath = path.join(rootDir || workspaceDir, relPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, contents, 'utf8');
  }
}

async function readOut(outDir: string, relPath: string) {
  return await fs.readFile(path.join(outDir, relPath), 'utf8');
}

async function loadValues(dir: string) {
  const g = new EnvGraph();
  await g.setRootDataSource(new DirectoryDataSource(dir));
  await g.finishLoad();
  const sourceErrors = g.sortedDataSources.flatMap((s) => s.errors.filter((e) => !e.isWarning));
  expect(sourceErrors, `expected no load errors, got: ${sourceErrors.map((e) => e.message).join(', ')}`).toEqual([]);
  await g.resolveEnvValues();
  const values: Record<string, any> = {};
  for (const key of Object.keys(g.configSchema)) {
    values[key] = g.configSchema[key].resolvedValue;
  }
  return values;
}

const API_DIR = 'packages/api';

function apiFlatten(opts?: { outDir?: string, includeLocal?: boolean, vendorPlugins?: boolean }) {
  return flattenEnvFiles({
    packageDir: path.join(workspaceDir, API_DIR),
    ...opts,
  });
}

/** write a realistic self-contained installed plugin package under node_modules */
async function writeInstalledPlugin(
  moduleName: string,
  version: string,
  extraPkgFields: Record<string, any> = {},
  atDir = workspaceDir,
) {
  const pluginDir = path.join(atDir, 'node_modules', moduleName);
  await fs.mkdir(path.join(pluginDir, 'dist'), { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, 'package.json'),
    JSON.stringify({
      name: moduleName, version, exports: { './plugin': './dist/plugin.cjs' }, ...extraPkgFields,
    }),
  );
  await fs.writeFile(path.join(pluginDir, 'dist', 'plugin.cjs'), `// installed ${moduleName}@${version}\n`);
  return pluginDir;
}

/**
 * Make `downloadPluginToCache` (the network fallback) return a freshly-created fake extracted
 * plugin package, so the download path has real bytes to copy without touching the network.
 * Returns the spy so tests can assert whether the fallback was used.
 */
function stubPluginDownload() {
  const spy = vi.mocked(downloadPluginToCache);
  spy.mockImplementation(async (moduleName: string, version: string) => {
    const cacheDir = path.join(baseDir, 'fake-cache', `${moduleName.replaceAll('/', '-')}-${version}`);
    await fs.mkdir(path.join(cacheDir, 'dist'), { recursive: true });
    await fs.writeFile(
      path.join(cacheDir, 'package.json'),
      JSON.stringify({ name: moduleName, version, exports: { './plugin': './dist/plugin.cjs' } }),
    );
    await fs.writeFile(path.join(cacheDir, 'dist', 'plugin.cjs'), `// downloaded ${moduleName}@${version}\n`);
    return cacheDir;
  });
  return spy;
}

describe('flattenEnvFiles', () => {
  test('copies external imports, rewrites paths, and output resolves identically', async () => {
    // .env.common has intentionally quirky formatting to check byte-for-byte copying
    const commonContents = outdent`
      # @import(./.env.common2)  # trailing comment
      # ---

      # a comment   with   weird spacing
      SIB_COMMON=from-sib


      SIB_COMMON_TWO="quoted value"
    `;
    await writeTree({
      '.env.shared': 'ROOT_SHARED=from-root\n',
      'packages/shared/.env.common': commonContents,
      'packages/shared/.env.common2': 'SIB_COMMON2=from-sib2\n',
      [`${API_DIR}/.env.schema`]: outdent`
        # @import(../../.env.shared)
        # @import(../shared/.env.common)
        # ---
        API_ITEM=api-value
      `,
      [`${API_DIR}/.env.local`]: 'LOCAL_ONLY=nope\n',
    });

    const result = await apiFlatten();

    // rewritten schema
    const schemaOut = await readOut(result.outDir, '.env.schema');
    expect(schemaOut).toContain('@import(./.env-imports/.env.shared)');
    expect(schemaOut).toContain('@import(./.env-imports/packages/shared/.env.common)');
    expect(schemaOut).toContain('API_ITEM=api-value');

    // imported files mirrored by workspace-relative path; untouched files are byte-identical
    expect(await readOut(result.outDir, '.env-imports/.env.shared')).toBe('ROOT_SHARED=from-root\n');
    expect(await readOut(result.outDir, '.env-imports/packages/shared/.env.common')).toBe(commonContents);
    expect(await readOut(result.outDir, '.env-imports/packages/shared/.env.common2')).toBe('SIB_COMMON2=from-sib2\n');

    // local file skipped
    expect(fsSync.existsSync(path.join(result.outDir, '.env.local'))).toBe(false);
    expect(result.skippedLocalFiles).toEqual([path.join(workspaceDir, API_DIR, '.env.local')]);

    expect(result.warnings).toEqual([]);

    // flattened output loads standalone and resolves the same values
    expect(await loadValues(result.outDir)).toEqual({
      API_ITEM: 'api-value',
      ROOT_SHARED: 'from-root',
      SIB_COMMON: 'from-sib',
      SIB_COMMON_TWO: 'quoted value',
      SIB_COMMON2: 'from-sib2',
    });
  });

  test('includeLocal copies local files', async () => {
    await writeTree({
      [`${API_DIR}/.env.schema`]: 'API_ITEM=api-value\n',
      [`${API_DIR}/.env.local`]: 'LOCAL_ONLY=yep\n',
    });
    const result = await apiFlatten({ includeLocal: true });
    expect(await readOut(result.outDir, '.env.local')).toBe('LOCAL_ONLY=yep\n');
    expect(result.skippedLocalFiles).toEqual([]);
  });

  test('copies conditionally-enabled imports and preserves the enabled condition', async () => {
    await writeTree({
      '.env.prodonly': 'PROD_ONLY=1\n',
      [`${API_DIR}/.env.schema`]: outdent`
        # @import(../../.env.prodonly, enabled=eq($APP_ENV, "production"))
        # ---
        APP_ENV=dev
      `,
    });
    const result = await apiFlatten();
    const schemaOut = await readOut(result.outDir, '.env.schema');
    expect(schemaOut).toContain('@import(./.env-imports/.env.prodonly, enabled=eq($APP_ENV, "production"))');
    expect(await readOut(result.outDir, '.env-imports/.env.prodonly')).toBe('PROD_ONLY=1\n');
  });

  test('directory imports are copied (excluding local files) and keep their trailing slash', async () => {
    await writeTree({
      'envs/.env.one': 'ONE=1\n',
      'envs/.env.local': 'TWO=2\n',
      'envs/not-an-env-file.txt': 'ignore me\n',
      [`${API_DIR}/.env.schema`]: outdent`
        # @import(../../envs/)
        # ---
        API_ITEM=api-value
      `,
    });
    const result = await apiFlatten();
    const schemaOut = await readOut(result.outDir, '.env.schema');
    expect(schemaOut).toContain('@import(./.env-imports/envs/)');
    expect(await readOut(result.outDir, '.env-imports/envs/.env.one')).toBe('ONE=1\n');
    expect(fsSync.existsSync(path.join(result.outDir, '.env-imports/envs/.env.local'))).toBe(false);
    expect(fsSync.existsSync(path.join(result.outDir, '.env-imports/envs/not-an-env-file.txt'))).toBe(false);
    expect(result.skippedLocalFiles).toEqual([path.join(workspaceDir, 'envs/.env.local')]);
  });

  test('pins npm plugin versions in external files, leaves package-internal plugins untouched', async () => {
    await writeTree({
      'node_modules/@varlock/fake-plugin/package.json': JSON.stringify({ name: '@varlock/fake-plugin', version: '1.2.3' }),
      '.env.shared': outdent`
        # @plugin(@varlock/fake-plugin)
        # ---
        ROOT_SHARED=from-root
      `,
      [`${API_DIR}/.env.schema`]: outdent`
        # @plugin(@varlock/internal-plugin)
        # @import(../../.env.shared)
        # ---
        API_ITEM=api-value
      `,
    });
    const result = await apiFlatten();

    const sharedOut = await readOut(result.outDir, '.env-imports/.env.shared');
    expect(sharedOut).toContain('@plugin(@varlock/fake-plugin@1.2.3)');

    // internal plugin decorator resolves from the package's own node_modules at runtime - untouched
    const schemaOut = await readOut(result.outDir, '.env.schema');
    expect(schemaOut).toContain('@plugin(@varlock/internal-plugin)');
    expect(schemaOut).not.toContain('internal-plugin@');

    expect(result.pinnedPlugins).toEqual([
      {
        moduleName: '@varlock/fake-plugin',
        version: '1.2.3',
        filePath: path.join(workspaceDir, '.env.shared'),
      },
    ]);
  });

  test('warns when an external plugin cannot be resolved for pinning', async () => {
    await writeTree({
      '.env.shared': outdent`
        # @plugin(@varlock/missing-plugin)
        # ---
        ROOT_SHARED=from-root
      `,
      [`${API_DIR}/.env.schema`]: outdent`
        # @import(../../.env.shared)
        # ---
        API_ITEM=api-value
      `,
    });
    const result = await apiFlatten();
    expect(result.warnings.some((w) => w.includes('@varlock/missing-plugin'))).toBe(true);
    // left untouched
    expect(await readOut(result.outDir, '.env-imports/.env.shared')).toContain('@plugin(@varlock/missing-plugin)');
  });

  test('vendors local-path plugins and rewrites their paths across the package boundary', async () => {
    await writeTree({
      'shared-plugin.js': 'export default {};\n',
      [`${API_DIR}/.env.schema`]: outdent`
        # @plugin(../../shared-plugin.js)
        # ---
        API_ITEM=api-value
      `,
    });
    const result = await apiFlatten();
    const schemaOut = await readOut(result.outDir, '.env.schema');
    expect(schemaOut).toContain('@plugin(./.env-imports/shared-plugin.js)');
    expect(await readOut(result.outDir, '.env-imports/shared-plugin.js')).toBe('export default {};\n');
  });

  test('warns when a copied local package plugin declares unbundled dependencies', async () => {
    await writeTree({
      'my-plugin/package.json': JSON.stringify({
        name: 'my-plugin', version: '1.0.0', exports: { './plugin': './plugin.js' }, dependencies: { 'some-dep': '^1.0.0' },
      }),
      'my-plugin/plugin.js': 'module.exports = {};\n',
      [`${API_DIR}/.env.schema`]: outdent`
        # @plugin(../../my-plugin/)
        # ---
        API_ITEM=api-value
      `,
    });
    const result = await apiFlatten();
    // still copied and rewritten, but flags the dependency gap
    expect(await readOut(result.outDir, '.env-imports/my-plugin/package.json')).toContain('my-plugin');
    expect(result.warnings.some((w) => w.includes('not bundled'))).toBe(true);
  });

  test('does not warn for a self-contained single-file local plugin', async () => {
    await writeTree({
      'plugin.js': 'module.exports = {};\n',
      [`${API_DIR}/.env.schema`]: '# @plugin(../../plugin.js)\n# ---\nAPI_ITEM=x\n',
    });
    const result = await apiFlatten();
    expect(result.warnings.some((w) => w.includes('not bundled'))).toBe(false);
  });

  describe('--vendor-plugins', () => {
    afterEach(() => vi.mocked(downloadPluginToCache).mockReset());

    test('copies the installed package (no download) and rewrites to a local path', async () => {
      const spy = stubPluginDownload();
      await writeInstalledPlugin('@varlock/fake-plugin', '1.2.3');
      await writeTree({
        '.env.shared': outdent`
          # @plugin(@varlock/fake-plugin)
          # ---
          ROOT_SHARED=from-root
        `,
        [`${API_DIR}/.env.schema`]: outdent`
          # @import(../../.env.shared)
          # ---
          API_ITEM=api-value
        `,
      });

      const result = await apiFlatten({ vendorPlugins: true });

      // installed locally, so it was copied - never downloaded
      expect(spy).not.toHaveBeenCalled();

      // the external file now points at the vendored local package, not an npm descriptor
      const sharedOut = await readOut(result.outDir, '.env-imports/.env.shared');
      expect(sharedOut).toContain('@plugin(../.env-plugins/varlock-fake-plugin_1.2.3)');
      expect(sharedOut).not.toContain('@varlock/fake-plugin@');

      // the installed package bytes were copied into the output
      const vendoredPkg = await readOut(result.outDir, '.env-plugins/varlock-fake-plugin_1.2.3/package.json');
      expect(JSON.parse(vendoredPkg).name).toBe('@varlock/fake-plugin');
      expect(await readOut(result.outDir, '.env-plugins/varlock-fake-plugin_1.2.3/dist/plugin.cjs')).toContain('installed @varlock/fake-plugin@1.2.3');

      expect(result.vendoredPlugins).toEqual([expect.objectContaining({ moduleName: '@varlock/fake-plugin', version: '1.2.3' })]);
      expect(result.pinnedPlugins).toEqual([]);
    });

    test('follows symlinked installs (pnpm store / workspace links)', async () => {
      // real package lives elsewhere; node_modules entry is a symlink to it, like pnpm/workspaces
      const realPkgDir = path.join(baseDir, 'store', 'fake-plugin');
      await fs.mkdir(path.join(realPkgDir, 'dist'), { recursive: true });
      await fs.writeFile(path.join(realPkgDir, 'package.json'), JSON.stringify({ name: '@varlock/fake-plugin', version: '4.0.0', exports: { './plugin': './dist/plugin.cjs' } }));
      await fs.writeFile(path.join(realPkgDir, 'dist', 'plugin.cjs'), '// symlinked build\n');
      const nmScope = path.join(workspaceDir, 'node_modules', '@varlock');
      await fs.mkdir(nmScope, { recursive: true });
      await fs.symlink(realPkgDir, path.join(nmScope, 'fake-plugin'), 'dir');

      await writeTree({
        [`${API_DIR}/.env.schema`]: outdent`
          # @plugin(@varlock/fake-plugin)
          # ---
          API_ITEM=api-value
        `,
      });

      const result = await apiFlatten({ vendorPlugins: true });
      // real files copied through the symlink, not a dangling link
      const vendoredPlugin = path.join(result.outDir, '.env-plugins/varlock-fake-plugin_4.0.0/dist/plugin.cjs');
      expect((await fs.lstat(vendoredPlugin)).isSymbolicLink()).toBe(false);
      expect(await fs.readFile(vendoredPlugin, 'utf8')).toContain('symlinked build');
    });

    test('also vendors package-internal npm plugins (no node_modules at runtime)', async () => {
      stubPluginDownload();
      await writeInstalledPlugin('@varlock/internal-plugin', '2.0.0');
      await writeTree({
        [`${API_DIR}/.env.schema`]: outdent`
          # @plugin(@varlock/internal-plugin)
          # ---
          API_ITEM=api-value
        `,
      });

      const result = await apiFlatten({ vendorPlugins: true });

      const schemaOut = await readOut(result.outDir, '.env.schema');
      expect(schemaOut).toContain('@plugin(./.env-plugins/varlock-internal-plugin_2.0.0)');
      expect(result.vendoredPlugins).toHaveLength(1);
    });

    test('downloads as a fallback when the pinned exact version is not installed', async () => {
      const spy = stubPluginDownload();
      await writeTree({
        [`${API_DIR}/.env.schema`]: outdent`
          # @plugin(@varlock/fake-plugin@3.1.0)
          # ---
          API_ITEM=api-value
        `,
      });

      const result = await apiFlatten({ vendorPlugins: true });
      expect(spy).toHaveBeenCalledWith('@varlock/fake-plugin', '3.1.0');
      expect(await readOut(result.outDir, '.env-plugins/varlock-fake-plugin_3.1.0/dist/plugin.cjs')).toContain('downloaded @varlock/fake-plugin@3.1.0');
      expect(result.vendoredPlugins).toEqual([expect.objectContaining({ moduleName: '@varlock/fake-plugin', version: '3.1.0' })]);
    });

    test('downloads when the installed version does not match a pinned exact version', async () => {
      const spy = stubPluginDownload();
      await writeInstalledPlugin('@varlock/fake-plugin', '1.0.0'); // installed != pinned
      await writeTree({
        [`${API_DIR}/.env.schema`]: '# @plugin(@varlock/fake-plugin@3.1.0)\n# ---\nAPI_ITEM=x\n',
      });

      const result = await apiFlatten({ vendorPlugins: true });
      expect(spy).toHaveBeenCalledWith('@varlock/fake-plugin', '3.1.0');
      expect(result.vendoredPlugins).toEqual([expect.objectContaining({ version: '3.1.0' })]);
    });

    test('copies each module@version only once when referenced from multiple files', async () => {
      const spy = stubPluginDownload();
      await writeInstalledPlugin('@varlock/fake-plugin', '1.2.3');
      await writeTree({
        '.env.shared': '# @plugin(@varlock/fake-plugin)\n# ---\nROOT_SHARED=x\n',
        '.env.other': '# @plugin(@varlock/fake-plugin)\n# ---\nOTHER=y\n',
        [`${API_DIR}/.env.schema`]: outdent`
          # @import(../../.env.shared)
          # @import(../../.env.other)
          # ---
          API_ITEM=api-value
        `,
      });

      const result = await apiFlatten({ vendorPlugins: true });
      expect(spy).not.toHaveBeenCalled();
      expect(result.vendoredPlugins).toHaveLength(1);
    });

    test('warns when a vendored plugin has unbundled runtime dependencies', async () => {
      stubPluginDownload();
      await writeInstalledPlugin('@varlock/fake-plugin', '1.0.0', { dependencies: { 'some-dep': '^1.0.0' } });
      await writeTree({
        [`${API_DIR}/.env.schema`]: outdent`
          # @plugin(@varlock/fake-plugin)
          # ---
          API_ITEM=api-value
        `,
      });

      const result = await apiFlatten({ vendorPlugins: true });
      expect(result.warnings.some((w) => w.includes('not bundled'))).toBe(true);
    });

    test('warns and skips when no concrete version can be resolved', async () => {
      const spy = stubPluginDownload();
      await writeTree({
        [`${API_DIR}/.env.schema`]: outdent`
          # @plugin(@varlock/unresolvable-plugin)
          # ---
          API_ITEM=api-value
        `,
      });

      const result = await apiFlatten({ vendorPlugins: true });
      expect(spy).not.toHaveBeenCalled();
      expect(result.vendoredPlugins).toEqual([]);
      expect(result.warnings.some((w) => w.includes('unresolvable-plugin'))).toBe(true);
      // left untouched
      expect(await readOut(result.outDir, '.env.schema')).toContain('@plugin(@varlock/unresolvable-plugin)');
    });
  });

  test('handles circular imports without hanging', async () => {
    await writeTree({
      '.env.a': outdent`
        # @import(./.env.b)
        # ---
        A=1
      `,
      '.env.b': outdent`
        # @import(./.env.a)
        # ---
        B=1
      `,
      [`${API_DIR}/.env.schema`]: outdent`
        # @import(../../.env.a)
        # ---
        API_ITEM=api-value
      `,
    });
    const result = await apiFlatten();
    // both copied once, their mutual (sibling-relative) imports unchanged
    expect(await readOut(result.outDir, '.env-imports/.env.a')).toContain('@import(./.env.b)');
    expect(await readOut(result.outDir, '.env-imports/.env.b')).toContain('@import(./.env.a)');
    expect(result.copiedFiles.filter((f) => f.src.endsWith('.env.a')).length).toBe(1);
  });

  test('allowMissing imports are rewritten silently; missing imports warn', async () => {
    await writeTree({
      [`${API_DIR}/.env.schema`]: outdent`
        # @import(../../.env.optional, allowMissing=true)
        # @import(../../.env.gone)
        # ---
        API_ITEM=api-value
      `,
    });
    const result = await apiFlatten();
    const schemaOut = await readOut(result.outDir, '.env.schema');
    expect(schemaOut).toContain('@import(./.env-imports/.env.optional, allowMissing=true)');
    expect(schemaOut).toContain('@import(./.env-imports/.env.gone)');
    expect(result.warnings.filter((w) => w.includes('.env.optional'))).toEqual([]);
    expect(result.warnings.some((w) => w.includes('.env.gone') && w.includes('does not exist'))).toBe(true);
  });

  test('imports from outside the repo are flattened like any other', async () => {
    await writeTree({ '.env.outside': 'OUTSIDE=1\n' }, baseDir);
    await writeTree({
      [`${API_DIR}/.env.schema`]: outdent`
        # @import(../../../.env.outside)
        # ---
        API_ITEM=api-value
      `,
    });
    const result = await apiFlatten();
    const schemaOut = await readOut(result.outDir, '.env.schema');
    expect(schemaOut).toContain('@import(./.env-imports/.env.outside)');
    expect(await readOut(result.outDir, '.env-imports/.env.outside')).toBe('OUTSIDE=1\n');
    expect(result.warnings).toEqual([]);
    expect(await loadValues(result.outDir)).toEqual({ API_ITEM: 'api-value', OUTSIDE: 1 });
  });

  // `.git` is a directory normally, but a file in a worktree or submodule
  test.each([
    ['directory', async (gitPath: string) => fs.mkdir(gitPath)],
    ['file (worktree)', async (gitPath: string) => fs.writeFile(gitPath, 'gitdir: /elsewhere\n')],
  ])('warns about files copied from outside the git repo (.git as %s)', async (_label, writeGitMarker) => {
    await writeGitMarker(path.join(workspaceDir, '.git'));
    await writeTree({ '.env.outside': 'OUTSIDE=1\n' }, baseDir);
    await writeTree({
      '.env.shared': 'INNER=1\n',
      [`${API_DIR}/.env.schema`]: outdent`
        # @import(../../../.env.outside)
        # @import(../../.env.shared)
        # ---
        API_ITEM=api-value
      `,
    });
    const result = await apiFlatten();

    // only the out-of-repo file is flagged, and it is copied all the same
    const outsideRepoWarnings = result.warnings.filter((w) => w.includes('outside the git repo'));
    expect(outsideRepoWarnings).toHaveLength(1);
    expect(outsideRepoWarnings[0]).toContain(path.join(baseDir, '.env.outside'));
    expect(await readOut(result.outDir, '.env-imports/.env.outside')).toBe('OUTSIDE=1\n');
    expect(await readOut(result.outDir, '.env-imports/repo/.env.shared')).toBe('INNER=1\n');
  });

  test('warns about gitignored files copied into the output, but not tracked ones', async () => {
    execFileSync('git', ['init', '-q'], { cwd: workspaceDir });
    await writeTree({
      // the common setup: ignore everything env-shaped, then force-add the ones that belong in git
      '.gitignore': '.env*\n',
      '.env.secret': 'SECRET=from-secret\n',
      '.env.shared': 'SHARED=from-shared\n',
      [`${API_DIR}/.env.schema`]: outdent`
        # @import(../../.env.secret)
        # @import(../../.env.shared)
        # ---
        API_ITEM=api-value
      `,
    });
    execFileSync('git', ['add', '-f', '.env.shared', `${API_DIR}/.env.schema`], { cwd: workspaceDir });
    const result = await apiFlatten();

    // only the gitignored one is flagged, and it is copied all the same
    const gitIgnoredWarnings = result.warnings.filter((w) => w.includes('is gitignored'));
    expect(gitIgnoredWarnings).toHaveLength(1);
    expect(gitIgnoredWarnings[0]).toContain('.env.secret');
    expect(await readOut(result.outDir, '.env-imports/.env.secret')).toBe('SECRET=from-secret\n');
    expect(await readOut(result.outDir, '.env-imports/.env.shared')).toBe('SHARED=from-shared\n');
  });

  test('warns about windows-native import paths instead of silently skipping them', async () => {
    await writeTree({
      [`${API_DIR}/.env.schema`]: [
        String.raw`# @import(..\..\.env.shared)`,
        String.raw`# @import(C:\proj\.env.abs)`,
        '# ---',
        'API_ITEM=api-value',
      ].join('\n'),
    });
    const result = await apiFlatten();

    // the separator case can just be respelled, the drive-letter one cannot
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toContain('forward slashes');
    expect(result.warnings[1]).toContain('absolute windows paths are not supported');
    // both are left exactly as written
    expect(await readOut(result.outDir, '.env.schema')).toContain(String.raw`@import(..\..\.env.shared)`);
  });

  // varlock only treats `/`-rooted paths as absolute imports, so a windows `C:\...` path built
  // by path.join here would not be recognized by flatten or by the loader
  test.skipIf(process.platform === 'win32')('absolute import paths are flattened', async () => {
    await writeTree({ 'elsewhere/.env.abs': 'ABS=1\n' }, baseDir);
    await writeTree({
      [`${API_DIR}/.env.schema`]: outdent`
        # @import(${path.join(baseDir, 'elsewhere', '.env.abs')})
        # ---
        API_ITEM=api-value
      `,
    });
    const result = await apiFlatten();
    const schemaOut = await readOut(result.outDir, '.env.schema');
    expect(schemaOut).toContain('@import(./.env-imports/elsewhere/.env.abs)');
    expect(await readOut(result.outDir, '.env-imports/elsewhere/.env.abs')).toBe('ABS=1\n');
    expect(result.warnings).toEqual([]);
  });

  test('the mirror base widens to cover every imported path, keeping them distinct', async () => {
    // same file name at two different levels - they must not collide in the output
    await writeTree({ '.env.shared': 'OUTER=outer\n' }, baseDir);
    await writeTree({
      '.env.shared': 'INNER=inner\n',
      [`${API_DIR}/.env.schema`]: outdent`
        # @import(../../../.env.shared)
        # @import(../../.env.shared)
        # ---
        API_ITEM=api-value
      `,
    });
    const result = await apiFlatten();
    const schemaOut = await readOut(result.outDir, '.env.schema');
    // base is the dir holding both, so the repo-level one keeps its `repo/` segment
    expect(schemaOut).toContain('@import(./.env-imports/.env.shared)');
    expect(schemaOut).toContain('@import(./.env-imports/repo/.env.shared)');
    expect(await readOut(result.outDir, '.env-imports/.env.shared')).toBe('OUTER=outer\n');
    expect(await readOut(result.outDir, '.env-imports/repo/.env.shared')).toBe('INNER=inner\n');
    expect(await loadValues(result.outDir)).toEqual({
      API_ITEM: 'api-value', OUTER: 'outer', INNER: 'inner',
    });
  });

  test('errors when no env files are found', async () => {
    await fs.mkdir(path.join(workspaceDir, API_DIR), { recursive: true });
    await expect(apiFlatten()).rejects.toThrow(FlattenError);
  });

  test('errors when the output dir would contain the package dir', async () => {
    await writeTree({ [`${API_DIR}/.env.schema`]: 'API_ITEM=1\n' });
    await expect(apiFlatten({ outDir: '../..' })).rejects.toThrow(FlattenError);
  });

  test('rerunning flatten replaces stale output', async () => {
    await writeTree({
      '.env.shared': 'ROOT_SHARED=old\n',
      [`${API_DIR}/.env.schema`]: outdent`
        # @import(../../.env.shared)
        # ---
        API_ITEM=api-value
      `,
    });
    await apiFlatten();
    // remove the import and rerun - previously copied file should be gone
    await writeTree({
      [`${API_DIR}/.env.schema`]: 'API_ITEM=api-value\n',
    });
    const result = await apiFlatten();
    expect(fsSync.existsSync(path.join(result.outDir, '.env-imports'))).toBe(false);
    expect(await readOut(result.outDir, '.env.schema')).toBe('API_ITEM=api-value\n');
  });
});
