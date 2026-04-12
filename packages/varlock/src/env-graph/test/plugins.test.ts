import {
  describe, test, expect, vi,
} from 'vitest';
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

  test('bad semver range', envFilesTest({
    envFile: outdent`
      # @plugin(@varlock/test-plugin@xxx)
      # ---
    `,
    earlyError: true,
  }));
  test('adding plugin twice in same file creates error', envFilesTest({
    envFile: outdent`
      # @plugin(./plugins/test-plugin)
      # @plugin(./plugins/test-plugin)
      # ---
    `,
    earlyError: true,
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
    earlyError: true,
  }));
  test('plugins cannot have naming conflicts for registered decorators/etc', envFilesTest({
    envFile: outdent`
      # @plugin(./plugins/test-plugin-conflict-1)
      # @plugin(./plugins/test-plugin-conflict-2)
      # ---
    `,
    earlyError: true,
  }));
  test('plugins cannot have version conflicts', envFilesTest({
    envFile: outdent`
      # @plugin(./plugins/test-plugin)
      # @plugin(./plugins/test-plugin-version-conflict)
      # ---
    `,
    earlyError: true,
  }));
  test('plugin folder must have package.json', envFilesTest({
    envFile: outdent`
      # @plugin(./plugins/test-plugin-no-package-json)
      # ---
    `,
    earlyError: true,
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
