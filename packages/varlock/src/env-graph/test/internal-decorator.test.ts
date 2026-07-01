import { describe, it, expect } from 'vitest';
import outdent from 'outdent';
import { EnvGraph } from '../index';
import { DotEnvFileDataSource } from '../lib/data-source';
import { createEnvGraphDataType } from '../lib/data-types';

async function loadSchema(contents: string) {
  const g = new EnvGraph();
  await g.setRootDataSource(new DotEnvFileDataSource('.env.schema', { overrideContents: contents }));
  await g.finishLoad();
  await g.resolveEnvValues();
  return g;
}

async function loadSchemaWithInternalType(contents: string) {
  const g = new EnvGraph();
  // mirrors a plugin data type (e.g. a service-account token) that defaults to @internal
  g.registerDataType(createEnvGraphDataType({ name: 'svc-token', sensitive: true, internal: true }));
  await g.setRootDataSource(new DotEnvFileDataSource('.env.schema', { overrideContents: contents }));
  await g.finishLoad();
  await g.resolveEnvValues();
  return g;
}

describe('@internal item decorator', () => {
  it('marks an item internal and still resolves its value', async () => {
    const g = await loadSchema(outdent`
      # @internal @sensitive
      OP_TOKEN=abc123
    `);
    const item = g.configSchema.OP_TOKEN;
    expect(item.isInternal).toBe(true);
    expect(item.resolvedValue).toBe('abc123');
    expect(item.errors.length).toBe(0);
  });

  it('can be referenced by other items via ref(), but is excluded from injected output', async () => {
    const g = await loadSchema(outdent`
      # @internal
      OP_TOKEN=abc123
      DB_URL=concat("postgres://", ref(OP_TOKEN), "@host")
      PUBLIC_VAR=hello
    `);

    // the internal "secret zero" still resolves and is usable by other items
    expect(g.configSchema.DB_URL.resolvedValue).toBe('postgres://abc123@host');

    // ...but is not part of the resolved env handed to the application
    const env = g.getResolvedEnvObject();
    expect(env).not.toHaveProperty('OP_TOKEN');
    expect(env.DB_URL).toBe('postgres://abc123@host');
    expect(env.PUBLIC_VAR).toBe('hello');
  });

  it('is excluded from the serialized graph blob', async () => {
    const g = await loadSchema(outdent`
      # @internal
      OP_TOKEN=abc123
      DB_URL=concat("x-", ref(OP_TOKEN))
    `);
    const blob = g.getSerializedGraph();
    expect(blob.config).not.toHaveProperty('OP_TOKEN');
    expect(blob.config).toHaveProperty('DB_URL');
  });

  it('is included (flagged) in the serialized graph when includeInternal is set', async () => {
    const g = await loadSchema(outdent`
      # @internal
      OP_TOKEN=abc123
      DB_URL=concat("x-", ref(OP_TOKEN))
    `);
    // inspection output (e.g. `load --format json-full`) opts in and tags the item
    const inspect = g.getSerializedGraph({ includeInternal: true });
    expect(inspect.config.OP_TOKEN).toMatchObject({ value: 'abc123', isInternal: true });
    // non-internal items are not tagged
    expect(inspect.config.DB_URL.isInternal).toBeUndefined();
  });

  it('can be opted back into resolved output via includeInternal', async () => {
    const g = await loadSchema(outdent`
      # @internal
      OP_TOKEN=abc123
    `);
    expect(g.getResolvedEnvObject()).not.toHaveProperty('OP_TOKEN');
    expect(g.getResolvedEnvObject({ includeInternal: true })).toHaveProperty('OP_TOKEN', 'abc123');
  });

  it('a data type with internal:true makes items internal by default', async () => {
    const g = await loadSchemaWithInternalType(outdent`
      # @type=svc-token
      OP_TOKEN=abc123
      PUBLIC_VAR=hello
    `);
    expect(g.configSchema.OP_TOKEN.isInternal).toBe(true);
    expect(g.configSchema.PUBLIC_VAR.isInternal).toBe(false);
    const env = g.getResolvedEnvObject();
    expect(env).not.toHaveProperty('OP_TOKEN');
    expect(env.PUBLIC_VAR).toBe('hello');
  });

  it('@internal=false overrides a data type internal default', async () => {
    const g = await loadSchemaWithInternalType(outdent`
      # @type=svc-token @internal=false
      OP_TOKEN=abc123
    `);
    expect(g.configSchema.OP_TOKEN.isInternal).toBe(false);
    expect(g.getResolvedEnvObject()).toHaveProperty('OP_TOKEN', 'abc123');
  });

  it('@internal=false does not mark the item as internal', async () => {
    const g = await loadSchema(outdent`
      # @internal=false
      FOO=bar
    `);
    expect(g.configSchema.FOO.isInternal).toBe(false);
    expect(g.getResolvedEnvObject()).toHaveProperty('FOO', 'bar');
  });

  it('is excluded from generated types', async () => {
    const g = new EnvGraph();
    await g.setRootDataSource(new DotEnvFileDataSource('.env.schema', {
      overrideContents: outdent`
        # @internal
        OP_TOKEN=abc123
        PUBLIC_VAR=hello
      `,
    }));
    await g.finishLoad();

    const { generateTsTypesSrc, resolveFieldTypes } = await import('../lib/type-generation');
    const items = [];
    for (const key of g.sortedConfigKeys) {
      const item = g.configSchema[key];
      if (item.isInternal) continue;
      if (!item.defsForTypeGeneration.length) continue;
      items.push(await item.getTypeGenInfo());
    }
    const src = await generateTsTypesSrc(resolveFieldTypes(items));
    expect(src).not.toContain('OP_TOKEN');
    expect(src).toContain('PUBLIC_VAR');
  });
});
