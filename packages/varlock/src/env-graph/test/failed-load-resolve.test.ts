import { describe, it, expect } from 'vitest';
import { EnvGraph } from '../index';
import { MultiplePathsContainerDataSource } from '../lib/data-source';

/**
 * `finishLoad()` bails before processing config items when any source failed to load or
 * parse, which leaves every item untyped. Resolving such a graph used to throw
 * `expected dataType to be set` from an un-awaited resolveItem() - an unhandledRejection,
 * with the promise the caller awaited hanging forever.
 */
describe('resolving a graph that failed to load', () => {
  async function buildFailedGraph() {
    const g = new EnvGraph();
    // an override means the item gets a value resolver regardless of its (missing) definition,
    // so resolution runs all the way to coercion - which is where the untyped item blew up
    g.overrideValues = { ITEM: 'from-process-env' };
    g.setVirtualImports('/virtual', {
      '.env.schema': 'ITEM=\n',
      '.env.local': 'VALID=ok\n@#$%^& this is not valid env syntax !!!\n',
    });
    await g.setRootDataSource(new MultiplePathsContainerDataSource([
      '/virtual/.env.schema',
      '/virtual/.env.local',
    ]));
    await g.finishLoad();
    return g;
  }

  it('does not mark the graph as loaded', async () => {
    const g = await buildFailedGraph();
    expect(g.configItemsProcessed).toBe(false);
    expect(g.sortedDataSources.some((s) => !s.isValid)).toBe(true);
  });

  it('rejects instead of hanging or throwing out of band', async () => {
    const g = await buildFailedGraph();
    const unhandled: Array<unknown> = [];
    const onRejection = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      const settled = g.resolveEnvValues().then(() => 'RESOLVED' as const, (err) => err);
      const timeout = new Promise<'STILL_PENDING'>((r) => {
        setTimeout(() => r('STILL_PENDING'), 200);
      });
      const result = await Promise.race([settled, timeout]);
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toMatch(/env graph failed to load/);
      // give any stray floating rejection a tick to surface
      await new Promise((r) => {
        setImmediate(r);
      });
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener('unhandledRejection', onRejection);
    }
  });
});

/**
 * The dependency walk starts each item's resolution without awaiting it, so an unexpected
 * throw has to be routed back to the promise resolveEnvValues() returns. Otherwise it
 * escapes as an unhandledRejection and that promise never settles.
 */
describe('an unexpected throw during item resolution', () => {
  it('rejects resolveEnvValues instead of hanging', async () => {
    const g = new EnvGraph();
    g.setVirtualImports('/virtual', { '.env.schema': 'A=one\nB=two\n' });
    await g.setRootDataSource(new MultiplePathsContainerDataSource(['/virtual/.env.schema']));
    await g.finishLoad();
    expect(g.configItemsProcessed).toBe(true);

    g.configSchema.A.resolve = async () => {
      throw new Error('boom');
    };

    const timeout = new Promise<'STILL_PENDING'>((r) => {
      setTimeout(() => r('STILL_PENDING'), 200);
    });
    const result = await Promise.race([
      g.resolveEnvValues().then(() => 'RESOLVED' as const, (err) => err),
      timeout,
    ]);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe('boom');
  });
});
