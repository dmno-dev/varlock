import {
  describe, test, expect, beforeEach, afterEach, vi,
} from 'vitest';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
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
    workspaceRootPath: workspaceDir,
    ...opts,
  });
}

/**
 * Make `downloadPluginToCache` return a freshly-created fake extracted plugin package
 * (a dir with package.json + a plugin file), so vendoring has real bytes to copy without
 * touching the network. Returns the spy so tests can assert on the calls.
 */
function stubPluginDownload(extraPkgFields: Record<string, any> = {}) {
  const spy = vi.mocked(downloadPluginToCache);
  spy.mockImplementation(async (moduleName: string, version: string) => {
    const cacheDir = path.join(baseDir, 'fake-cache', `${moduleName.replaceAll('/', '-')}-${version}`);
    await fs.mkdir(path.join(cacheDir, 'dist'), { recursive: true });
    await fs.writeFile(
      path.join(cacheDir, 'package.json'),
      JSON.stringify({
        name: moduleName, version, exports: { './plugin': './dist/plugin.cjs' }, ...extraPkgFields,
      }),
    );
    await fs.writeFile(path.join(cacheDir, 'dist', 'plugin.cjs'), `// ${moduleName}@${version}\n`);
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

  describe('--vendor-plugins', () => {
    afterEach(() => vi.mocked(downloadPluginToCache).mockReset());

    test('downloads npm plugins, copies them in, and rewrites to a local path', async () => {
      const spy = stubPluginDownload();
      await writeTree({
        'node_modules/@varlock/fake-plugin/package.json': JSON.stringify({ name: '@varlock/fake-plugin', version: '1.2.3' }),
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

      // resolved the range to the installed version and downloaded that
      expect(spy).toHaveBeenCalledWith('@varlock/fake-plugin', '1.2.3');

      // the external file now points at the vendored local package, not an npm descriptor
      const sharedOut = await readOut(result.outDir, '.env-imports/.env.shared');
      expect(sharedOut).toContain('@plugin(../.env-plugins/varlock-fake-plugin_1.2.3)');
      expect(sharedOut).not.toContain('@varlock/fake-plugin@');

      // the package bytes were copied into the output
      const vendoredPkg = await readOut(result.outDir, '.env-plugins/varlock-fake-plugin_1.2.3/package.json');
      expect(JSON.parse(vendoredPkg).name).toBe('@varlock/fake-plugin');
      expect(await readOut(result.outDir, '.env-plugins/varlock-fake-plugin_1.2.3/dist/plugin.cjs')).toContain('@varlock/fake-plugin@1.2.3');

      expect(result.vendoredPlugins).toEqual([expect.objectContaining({ moduleName: '@varlock/fake-plugin', version: '1.2.3' })]);
      expect(result.pinnedPlugins).toEqual([]);
    });

    test('also vendors package-internal npm plugins (no node_modules at runtime)', async () => {
      stubPluginDownload();
      await writeTree({
        'node_modules/@varlock/internal-plugin/package.json': JSON.stringify({ name: '@varlock/internal-plugin', version: '2.0.0' }),
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

    test('honors an already-pinned exact version even without a local install', async () => {
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
      expect(result.vendoredPlugins).toEqual([expect.objectContaining({ moduleName: '@varlock/fake-plugin', version: '3.1.0' })]);
    });

    test('downloads each module@version only once when referenced from multiple files', async () => {
      const spy = stubPluginDownload();
      await writeTree({
        'node_modules/@varlock/fake-plugin/package.json': JSON.stringify({ name: '@varlock/fake-plugin', version: '1.2.3' }),
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
      expect(spy).toHaveBeenCalledTimes(1);
      expect(result.vendoredPlugins).toHaveLength(1);
    });

    test('warns when a vendored plugin has unbundled runtime dependencies', async () => {
      stubPluginDownload({ dependencies: { 'some-dep': '^1.0.0' } });
      await writeTree({
        [`${API_DIR}/.env.schema`]: outdent`
          # @plugin(@varlock/fake-plugin@1.0.0)
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

  test('imports pointing outside the workspace root are left untouched with a warning', async () => {
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
    expect(schemaOut).toContain('@import(../../../.env.outside)');
    expect(result.warnings.some((w) => w.includes('outside the workspace root'))).toBe(true);
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
