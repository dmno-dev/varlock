import { describe, it, expect } from 'vitest';
import outdent from 'outdent';
import { EnvGraph, DotEnvFileDataSource } from '../../../env-graph';
import { planFilterResolution } from '../item-filter';

async function loadGraph(envFile: string) {
  const g = new EnvGraph();
  await g.setRootDataSource(new DotEnvFileDataSource('.env.schema', { overrideContents: envFile }));
  await g.finishLoad();
  return g;
}

describe('planFilterResolution', () => {
  it('resolves everything (resolveKeys undefined) when --filter is unset', async () => {
    const g = await loadGraph('FOO=bar');
    expect(planFilterResolution(g, undefined).resolveKeys).toBeUndefined();
  });

  it('scopes to matched keys plus transitive deps for a key filter', async () => {
    const g = await loadGraph(outdent`
      STRIPE_KEY=concat("sk-", ref(STRIPE_SUFFIX))
      STRIPE_SUFFIX=abc
      OTHER_VAR=hello
    `);
    const plan = planFilterResolution(g, 'STRIPE_KEY');
    expect(new Set(plan.resolveKeys)).toEqual(new Set(['STRIPE_KEY', 'STRIPE_SUFFIX']));
  });

  it('scopes to matched keys for a glob filter (no deps here)', async () => {
    const g = await loadGraph(outdent`
      STRIPE_KEY=abc
      STRIPE_SECRET=def
      OTHER_VAR=hello
    `);
    const plan = planFilterResolution(g, 'STRIPE_*');
    expect(new Set(plan.resolveKeys)).toEqual(new Set(['STRIPE_KEY', 'STRIPE_SECRET']));
  });

  it('scopes to matched keys for a #tag filter', async () => {
    const g = await loadGraph(outdent`
      # @tag(frontend)
      FRONTEND_VAR=hello
      BACKEND_VAR=world
    `);
    const plan = planFilterResolution(g, '#frontend');
    expect(new Set(plan.resolveKeys)).toEqual(new Set(['FRONTEND_VAR']));
  });

  it('falls back to full resolution when the filter uses @sensitive', async () => {
    const g = await loadGraph(outdent`
      # @sensitive
      SECRET_VAR=abc
      PUBLIC_VAR=def
    `);
    expect(planFilterResolution(g, '@sensitive').resolveKeys).toBeUndefined();
  });

  it('falls back to full resolution when the filter mixes a decorator selector with others', async () => {
    const g = await loadGraph(outdent`
      FOO=bar
    `);
    expect(planFilterResolution(g, 'FOO,@required').resolveKeys).toBeUndefined();
  });

  it('throws for invalid filter syntax', async () => {
    const g = await loadGraph('FOO=bar');
    expect(() => planFilterResolution(g, '@bogus')).toThrow(/unknown decorator selector/);
  });
});

describe('scoped resolution skips validating filtered-out items', () => {
  it('a required-but-empty item outside the filter does not block resolution', async () => {
    const g = await loadGraph(outdent`
      # @tag(frontend)
      FRONTEND_VAR=hello

      # @required
      BACKEND_SECRET=
    `);
    const plan = planFilterResolution(g, '#frontend');
    await g.resolveEnvValues(plan.resolveKeys);

    expect(g.configSchema.FRONTEND_VAR.isResolved).toBe(true);
    expect(g.configSchema.FRONTEND_VAR.validationState).toBe('valid');
    // never resolved, so no validation error was ever raised for it
    expect(g.configSchema.BACKEND_SECRET.isResolved).toBe(false);
    expect(g.configSchema.BACKEND_SECRET.validationState).toBe('valid');
  });

  it('a required-but-empty item inside the filter still fails validation', async () => {
    const g = await loadGraph(outdent`
      # @tag(frontend) @required
      FRONTEND_SECRET=
    `);
    const plan = planFilterResolution(g, '#frontend');
    await g.resolveEnvValues(plan.resolveKeys);

    expect(g.configSchema.FRONTEND_SECRET.isResolved).toBe(true);
    expect(g.configSchema.FRONTEND_SECRET.validationState).toBe('error');
  });

  it('a decorator-selector filter still catches an unrelated invalid item (full resolution)', async () => {
    const g = await loadGraph(outdent`
      # @sensitive
      SECRET_VAR=abc

      # @required
      BACKEND_SECRET=
    `);
    const plan = planFilterResolution(g, '@sensitive');
    await g.resolveEnvValues(plan.resolveKeys);

    expect(g.configSchema.BACKEND_SECRET.isResolved).toBe(true);
    expect(g.configSchema.BACKEND_SECRET.validationState).toBe('error');
  });
});
