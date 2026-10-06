import {
  describe, test, expect, vi, beforeAll, afterAll, beforeEach, afterEach,
} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import outdent from 'outdent';
import { envFilesTest } from './helpers/generic-test';
import { EnvGraph, DotEnvFileDataSource } from '../index';

describe('plugins ', () => {
  test('validate simple plugin works', envFilesTest({
    envFile: outdent`
      # @plugin(./plugins/test-plugin/)
      # ---
      PLUGIN_RESOLVER_TEST=test(foo)
    `,
    expectValues: { PLUGIN_RESOLVER_TEST: 'foo' },
  }));

  // plugins install during finishInit, before the @cache root decorator is applied, so
  // an accessor bound to whatever store existed at install time silently ignored the
  // policy - every plugin cacheTtl fell through to a no-op store
  test('plugin cache follows the @cache policy applied after plugins install', envFilesTest({
    envFile: outdent`
      # @plugin(./plugins/test-plugin-with-cache/)
      # @cache=memory
      # ---
      FIRST=cachedRun()
      SECOND=cachedRun()
    `,
    // both share one cache key, so a live store means one producer run and one value
    expectValues: { FIRST: 'run-1', SECOND: 'run-1' },
  }));

  // bundlers can split a CJS plugin into chunks that `require('./plugin.cjs')` back.
  // the entry must not re-run outside the plugin context when that happens (#1113)
  test('lazily loaded chunk can require the plugin entry back', envFilesTest({
    envFile: outdent`
      # @plugin(./plugins/test-plugin-split-chunks/)
      # ---
      CHUNKED=chunked(foo)
    `,
    expectValues: { CHUNKED: 'chunk:foo' },
  }));

  // node resolves the chunk's require to the real path, so a plugin loaded through a
  // symlink (pnpm, workspaces) must be cached under its real path too
  describe('split-chunk plugin loaded through a symlink', () => {
    const symlinkPath = path.join(__dirname, 'plugins/.tmp-symlinked-split-chunks');
    beforeAll(() => {
      fs.rmSync(symlinkPath, { force: true, recursive: true });
      fs.symlinkSync(path.join(__dirname, 'plugins/test-plugin-split-chunks-symlinked'), symlinkPath, 'junction');
    });
    afterAll(() => {
      fs.rmSync(symlinkPath, { force: true, recursive: true });
    });

    test('lazily loaded chunk can require the plugin entry back', envFilesTest({
      envFile: outdent`
        # @plugin(./plugins/.tmp-symlinked-split-chunks/)
        # ---
        CHUNKED=chunked(foo)
      `,
      expectValues: { CHUNKED: 'chunk:foo' },
    }));
  });

  test('bad semver range', envFilesTest({
    envFile: outdent`
      # @plugin(@varlock/test-plugin@xxx)
      # ---
    `,
    expectError: true,
  }));
  test('adding plugin twice in same file creates error', envFilesTest({
    envFile: outdent`
      # @plugin(./plugins/test-plugin)
      # @plugin(./plugins/test-plugin)
      # ---
    `,
    expectError: true,
  }));
  test('adding plugin in multiple files is allowed', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @plugin(./plugins/test-plugin)
        # ---
        FOO=asdf
      `,
      '.env.local': outdent`
        # @plugin(./plugins/test-plugin)
        # ---
      `,
    },
    // TODO: check for absence of error instead
    expectValues: { FOO: 'asdf' },
  }));

  test('non @varlock plugin blocked', envFilesTest({
    envFile: outdent`
      # @plugin(not-varlock-plugin)
      # ---
    `,
    expectError: true,
  }));
  test('plugins cannot have naming conflicts for registered decorators/etc', envFilesTest({
    envFile: outdent`
      # @plugin(./plugins/test-plugin-conflict-1)
      # @plugin(./plugins/test-plugin-conflict-2)
      # ---
    `,
    expectError: true,
  }));
  test('plugins cannot have version conflicts', envFilesTest({
    envFile: outdent`
      # @plugin(./plugins/test-plugin)
      # @plugin(./plugins/test-plugin-version-conflict)
      # ---
    `,
    expectError: true,
  }));
  test('plugin folder must have package.json', envFilesTest({
    envFile: outdent`
      # @plugin(./plugins/test-plugin-no-package-json)
      # ---
    `,
    expectError: true,
  }));

  test('warning on item does not block plugin resolver on same item', envFilesTest({
    envFile: outdent`
      # @plugin(./plugins/test-plugin/)
      # ---
      # @warn
      PLUGIN_RESOLVER_TEST=test(foo)
    `,
    expectValues: { PLUGIN_RESOLVER_TEST: 'foo' },
  }));

  test('warning on one item does not block other items', envFilesTest({
    envFile: outdent`
      # @plugin(./plugins/test-plugin/)
      # ---
      # @warn
      WARNED_ITEM=some_value
      OTHER_ITEM=test(bar)
    `,
    expectValues: { WARNED_ITEM: 'some_value', OTHER_ITEM: 'bar' },
  }));

  test('plugin bundled icons are registered on the graph', async () => {
    const currentDir = path.dirname(expect.getState().testPath!);
    vi.spyOn(process, 'cwd').mockReturnValue(currentDir);
    const g = new EnvGraph();
    await g.setRootDataSource(new DotEnvFileDataSource('.env.schema', {
      overrideContents: '# @plugin(./plugins/test-plugin/)\n# ---\nITEM=foo',
    }));
    await g.finishLoad();
    expect(g.bundledIcons['test-plugin:icon']).toBe('<svg>test</svg>');
  });

  test('plugin data types and resolvers without an icon inherit the plugin icon', async () => {
    const currentDir = path.dirname(expect.getState().testPath!);
    vi.spyOn(process, 'cwd').mockReturnValue(currentDir);
    const g = new EnvGraph();
    await g.setRootDataSource(new DotEnvFileDataSource('.env.schema', {
      overrideContents: outdent`
        # @plugin(./plugins/test-plugin/)
        # @plugin(./plugins/test-plugin-with-cache/)
        # ---
        # @type=testPluginIconless
        INHERITED=
        # @type=testPluginOwnIcon
        OWN=
        # @type=testPluginFnType
        FN_TYPE=
        # @type=testCachePluginType
        NO_PLUGIN_ICON=
      `,
    }));
    await g.finishLoad();
    expect((await g.configSchema.INHERITED.getTypeGenInfo()).icon).toBe('test-plugin:icon');
    expect((await g.configSchema.OWN.getTypeGenInfo()).icon).toBe('test-plugin:own-icon');
    expect((await g.configSchema.FN_TYPE.getTypeGenInfo()).icon).toBe('test-plugin:icon');
    expect((await g.configSchema.NO_PLUGIN_ICON.getTypeGenInfo()).icon).toBeUndefined();
    // resolvers inherit the same way (`test` sets no icon of its own)
    expect(g.registeredResolverFunctions.test.def.icon).toBe('test-plugin:icon');
    expect(g.registeredResolverFunctions.cachedRun.def.icon).toBeUndefined();
  });

  describe('standardVars warnings', () => {
    async function loadGraphWithPlugin(envFile: string, overrideValues: Record<string, string>) {
      const currentDir = path.dirname(expect.getState().testPath!);
      vi.spyOn(process, 'cwd').mockReturnValue(currentDir);
      const g = new EnvGraph();
      g.overrideValues = overrideValues;
      const source = new DotEnvFileDataSource('.env.schema', { overrideContents: envFile });
      await g.setRootDataSource(source);
      await g.finishLoad();
      return g;
    }

    test('warns when standard var is in environment but not wired to init decorator', async () => {
      const g = await loadGraphWithPlugin(
        outdent`
          # @plugin(./plugins/test-plugin-with-standard-vars/)
          # @initTestStdVars()
          # ---
          MY_PLUGIN_TOKEN=
        `,
        { MY_PLUGIN_TOKEN: 'some-token-value' },
      );
      const plugin = g.plugins.find((p) => p.name === '@varlock/test-plugin-with-standard-vars');
      expect(plugin).toBeDefined();
      expect(plugin!.warnings.length).toBe(1);
      expect(plugin!.warnings[0].message).toContain('MY_PLUGIN_TOKEN');
      expect(plugin!.warnings[0].message).toContain('not connected to plugin');
    });

    test('no warning when standard var is wired via init decorator', async () => {
      const g = await loadGraphWithPlugin(
        outdent`
          # @plugin(./plugins/test-plugin-with-standard-vars/)
          # @initTestStdVars(token=$MY_PLUGIN_TOKEN)
          # ---
          MY_PLUGIN_TOKEN=
        `,
        { MY_PLUGIN_TOKEN: 'some-token-value' },
      );
      const plugin = g.plugins.find((p) => p.name === '@varlock/test-plugin-with-standard-vars');
      expect(plugin).toBeDefined();
      expect(plugin!.warnings.length).toBe(0);
    });

    test('no warning when standard var is not in environment', async () => {
      const g = await loadGraphWithPlugin(
        outdent`
          # @plugin(./plugins/test-plugin-with-standard-vars/)
          # @initTestStdVars()
          # ---
          MY_PLUGIN_TOKEN=
        `,
        {},
      );
      const plugin = g.plugins.find((p) => p.name === '@varlock/test-plugin-with-standard-vars');
      expect(plugin).toBeDefined();
      expect(plugin!.warnings.length).toBe(0);
    });
  });
});

// published npm versions are immutable, so a cached pinned plugin must load without asking
// the registry - otherwise offline loads fail even after `varlock install-plugin` (#1189)
describe('cached npm plugins', () => {
  let tmpDir: string;
  let originalXdg: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-plugin-cache-test-'));
    originalXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = path.join(tmpDir, 'config');
    vi.spyOn(process, 'cwd').mockReturnValue(path.join(tmpDir));
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unable to connect'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function loadGraph(envFile: string) {
    const g = new EnvGraph();
    await g.setRootDataSource(new DotEnvFileDataSource('.env.schema', { overrideContents: envFile }));
    await g.finishLoad();
    return g;
  }

  test('loads a cached plugin without calling the registry', async () => {
    const cacheDir = path.join(tmpDir, 'config', 'varlock', 'plugins-cache');
    const dirName = 'varlock-test-plugin_1.2.3_abcd1234';
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.cpSync(path.join(__dirname, 'plugins/test-plugin'), path.join(cacheDir, dirName), { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'index.json'), JSON.stringify({
      'https://registry.npmjs.org/@varlock/test-plugin/-/test-plugin-1.2.3.tgz': dirName,
    }));

    const g = await loadGraph(outdent`
      # @plugin(@varlock/test-plugin@1.2.3)
      # ---
      PLUGIN_RESOLVER_TEST=test(foo)
    `);
    await g.resolveEnvValues();
    expect(g.configSchema.PLUGIN_RESOLVER_TEST.resolvedValue).toBe('foo');
    expect(fetch).not.toHaveBeenCalled();
  });

  test('registry failure on a cache miss names the plugin and url', async () => {
    const g = await loadGraph(outdent`
      # @plugin(@varlock/test-plugin@1.2.3)
      # ---
      FOO=bar
    `);
    const errors = g.rootDataSource!.getRootDecFns('plugin')[0]._errors;
    expect(errors[0].message).toContain('@varlock/test-plugin@1.2.3');
    expect(errors[0].message).toContain('https://registry.npmjs.org/@varlock/test-plugin/1.2.3');
    expect(errors[0].message).toContain('Unable to connect');
  });
});
