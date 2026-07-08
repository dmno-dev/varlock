import { describe, test } from 'vitest';
import outdent from 'outdent';
import { envFilesTest } from './helpers/generic-test';

describe('@tag decorator', () => {
  test('no @tag() - empty tags array', envFilesTest({
    envFile: outdent`
      UNTAGGED=
    `,
    expectTags: {
      UNTAGGED: [],
    },
  }));

  test('single @tag() call with one tag', envFilesTest({
    envFile: outdent`
      ITEM= # @tag(billing)
    `,
    expectTags: {
      ITEM: ['billing'],
    },
  }));

  test('single @tag() call with multiple tags', envFilesTest({
    envFile: outdent`
      ITEM= # @tag(billing, prod)
    `,
    expectTags: {
      ITEM: ['billing', 'prod'],
    },
  }));

  test('multiple @tag() calls accumulate', envFilesTest({
    envFile: outdent`
      # @tag(billing)
      # @tag(prod, critical)
      ITEM=
    `,
    expectTags: {
      ITEM: ['billing', 'prod', 'critical'],
    },
  }));
});
