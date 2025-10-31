import { describe, test } from 'vitest';
import outdent from 'outdent';
import { envFilesTest } from './helpers/generic-test';

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
});
