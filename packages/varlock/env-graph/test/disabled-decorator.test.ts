import { describe, it } from 'vitest';
import outdent from 'outdent';
import { envFilesTest } from './helpers/generic-test';

describe('@disable root decorator', () => {
  it('skips loading config items from a disabled data source', envFilesTest({
    envFile: outdent`
      # @disable=true
      # ---
      FOO=bar
    `,
    expectNotInSchema: ['FOO'],
  }));

  it('does not disable data source when @disable is false', envFilesTest({
    envFile: outdent`
      # @disable=false
      # ---
      FOO=bar
    `,
    expectValues: {
      FOO: 'bar',
    },
  }));
  it('disables data source with just @disable (no value)', envFilesTest({
    envFile: outdent`
      # @disable
      # ---
      FOO=bar
    `,
    expectNotInSchema: ['FOO'],
  }));

  it('value must resolve to boolean', envFilesTest({
    envFile: outdent`
      # @disable=badvalue
      # ---
      FOO=bar
    `,
    loadingError: true,
  }));
});
