import { describe, it, expect } from 'vitest';
import outdent from 'outdent';
import { EnvGraph } from '../index';
import { DotEnvFileDataSource } from '../lib/data-source';

async function loadSchema(contents: string) {
  const g = new EnvGraph();
  await g.setRootDataSource(new DotEnvFileDataSource('.env.schema', { overrideContents: contents }));
  await g.finishLoad();
  await g.resolveEnvValues();
  return g;
}

// A warning is advisory — it must not invalidate an item or prevent other items from
// referencing it. `@warn` is a test-only decorator that attaches a warning to an item.
describe('warnings do not invalidate items', () => {
  it('a warn-state item is still valid', async () => {
    const g = await loadSchema(outdent`
      # @warn
      WARNED=hello
    `);
    const item = g.configSchema.WARNED;
    expect(item.validationState).toBe('warn');
    expect(item.isValid).toBe(true);
    expect(item.resolvedValue).toBe('hello');
  });

  it('a warn-state item can still be referenced by another item', async () => {
    const g = await loadSchema(outdent`
      # @warn
      WARNED=hello
      DEPENDENT=concat("x-", ref(WARNED))
    `);
    expect(g.configSchema.DEPENDENT.validationState).not.toBe('error');
    expect(g.configSchema.DEPENDENT.resolvedValue).toBe('x-hello');
  });

  it('a real error still invalidates an item and blocks referencing', async () => {
    const g = await loadSchema(outdent`
      # @required
      BROKEN=
      DEPENDENT=concat("x-", ref(BROKEN))
    `);
    expect(g.configSchema.BROKEN.isValid).toBe(false);
    expect(g.configSchema.DEPENDENT.validationState).toBe('error');
  });
});
