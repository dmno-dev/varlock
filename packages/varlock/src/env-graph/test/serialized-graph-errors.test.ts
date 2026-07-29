import { describe, it, expect } from 'vitest';
import outdent from 'outdent';
import { EnvGraph } from '../index';
import { DotEnvFileDataSource } from '../lib/data-source';

async function loadSchema(contents: string, overrideValues?: Record<string, string>) {
  const g = new EnvGraph();
  await g.setRootDataSource(new DotEnvFileDataSource('.env.schema', { overrideContents: contents }));
  await g.finishLoad();
  if (overrideValues) g.overrideValues = overrideValues;
  await g.resolveEnvValues();
  return g;
}

describe('getSerializedGraph errors', () => {
  it('omits the errors key entirely when everything resolves', async () => {
    const g = await loadSchema('FOO=bar # @public');
    expect(g.getSerializedGraph().errors).toBeUndefined();
  });

  it('gives each item error a stable code, not just a message', async () => {
    const g = await loadSchema(outdent`
      # @required @public
      NEEDS_VALUE=
    `);
    const errors = g.getSerializedGraph().errors;
    expect(errors?.configItems?.NEEDS_VALUE).toEqual([expect.objectContaining({ code: 'empty_required_value', severity: 'error' })]);
  });

  it('codes distinguish failure kinds that share a validation state', async () => {
    const coercion = await loadSchema(outdent`
      # @required @type=number @public
      PORT=
    `, { PORT: 'not-a-number' });
    const schema = await loadSchema(outdent`
      # @totallyUnknownDecorator=1 @public
      FOO=bar
    `);
    expect(coercion.getSerializedGraph().errors?.configItems?.PORT?.[0].code).toBe('coercion_failed');
    expect(schema.getSerializedGraph().errors?.configItems?.FOO?.[0].code).toBe('schema_error');
  });

  it('keys to an array so an item failing several ways keeps every error', async () => {
    // stray text after a decorator is a warning; the empty @required is a real
    // error. They split across the two buckets, and the item appears in both.
    const g = await loadSchema(outdent`
      # @required stray words here
      # @public
      NEEDS_VALUE=
    `);
    const serialized = g.getSerializedGraph();
    expect(serialized.errors?.configItems?.NEEDS_VALUE).toEqual([expect.objectContaining({ code: 'empty_required_value', severity: 'error' })]);
    expect(serialized.warnings?.configItems?.NEEDS_VALUE).toEqual([expect.objectContaining({ code: 'schema_error', severity: 'warning' })]);
  });

  // `errors` being present has to keep meaning "the load failed" - our own
  // runtime and the cloudflare integration both test it for truthiness, so a
  // warning must never land in it.
  it('keeps warning-only items out of errors entirely', async () => {
    const g = await loadSchema(outdent`
      # @public stray words here
      FINE=bar
    `);
    const serialized = g.getSerializedGraph();
    expect(serialized.errors).toBeUndefined();
    expect(serialized.warnings?.configItems?.FINE).toEqual([expect.objectContaining({ code: 'schema_error', severity: 'warning' })]);
  });

  it('omits the warnings key when there are none', async () => {
    const g = await loadSchema('FOO=bar # @public');
    expect(g.getSerializedGraph().warnings).toBeUndefined();
  });

  // A project does not need a .env.schema - plain .env files are enough. What it
  // does need is at least one file, and at least one item defined in it. Both of
  // those failures used to be invisible in the serialized graph, so a consumer
  // reading `errors` saw a clean load with an empty config.
  it('reports no_config_items when files load but define nothing', async () => {
    const g = await loadSchema('# just a comment, no items\n');
    const errors = g.getSerializedGraph().errors;
    expect(errors?.root).toEqual([expect.objectContaining({ code: 'no_config_items', severity: 'error' })]);
  });

  it('does not report no_config_items when a schema-less file defines items', async () => {
    const g = await loadSchema('FOO=bar # @public');
    expect(g.getSerializedGraph().errors).toBeUndefined();
  });

  it('does not mask a parse error with an empty-config error', async () => {
    // a file that fails to parse defines no items either, but "no items" would
    // be a misleading thing to report - the parse error is the real problem
    const g = await loadSchema('@bogus(((\nBROKEN=\n');
    const rootCodes = g.getSerializedGraph().errors?.root?.map((e) => e.code);
    expect(rootCodes).toContain('parse_error');
    expect(rootCodes).not.toContain('no_config_items');
  });
});
