import { describe, test, expect } from 'vitest';
import outdent from 'outdent';
import { envFilesTest } from './helpers/generic-test';
import { EnvGraph } from '../index';
import { DotEnvFileDataSource } from '../lib/data-source';

async function loadSchema(contents: string) {
  const g = new EnvGraph();
  await g.setRootDataSource(new DotEnvFileDataSource('.env.schema', { overrideContents: contents }));
  await g.finishLoad();
  await g.resolveEnvValues();
  return g;
}

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

  test('duplicate tags collapse silently', envFilesTest({
    envFile: outdent`
      # @tag(billing, billing)
      # @tag(billing)
      ITEM=
    `,
    expectTags: {
      ITEM: ['billing'],
    },
  }));
});

describe('@tag name validation', () => {
  test.each([
    ['has space', '"has space"'],
    ['has,comma', '"has,comma"'],
    ['!leading-bang', '"!leading-bang"'],
    ['#leading-hash', '"#leading-hash"'],
    ['glob*char', '"glob*char"'],
    ['dotted.name', '"dotted.name"'],
  ])('rejects invalid tag name %s', async (tag, quoted) => {
    const g = await loadSchema(`ITEM=val # @tag(${quoted})`);
    const item = g.configSchema.ITEM;
    expect(item.validationState).toBe('error');
    expect(item.errors.map((e) => e.message).join('\n')).toContain(`invalid tag name "${tag}"`);
    expect(item.tags).toEqual([]);
  });

  test('accepts letters, numbers, "_", and "-"', async () => {
    const g = await loadSchema('ITEM=val # @tag(billing, v2, my-app, my_app)');
    expect(g.configSchema.ITEM.validationState).toBe('valid');
    expect(g.configSchema.ITEM.tags).toEqual(['billing', 'v2', 'my-app', 'my_app']);
  });

  test('rejects an empty @tag() call', async () => {
    const g = await loadSchema('ITEM=val # @tag()');
    const item = g.configSchema.ITEM;
    expect(item.validationState).toBe('error');
    expect(item.errors.map((e) => e.message).join('\n')).toContain('requires at least one tag');
  });

  test('a valid tag in the same call still applies alongside an invalid one', async () => {
    const g = await loadSchema('ITEM=val # @tag(billing, "bad tag")');
    const item = g.configSchema.ITEM;
    expect(item.validationState).toBe('error');
    expect(item.tags).toEqual(['billing']);
  });
});
