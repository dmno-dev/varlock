import { describe, it, expect } from 'vitest';
import { EnvGraph } from '../index';
import { DotEnvFileDataSource, MultiplePathsContainerDataSource } from '../lib/data-source';
import { ResolutionError } from '../lib/errors';

/**
 * finishLoad() returns early when a sibling source fails to parse, leaving
 * schema items unprocessed (dataType unset). If that key is also in
 * process.env / overrideValues, ConfigItem.resolve used to throw
 * `expected dataType to be set` from an un-awaited resolveItem — an
 * unhandledRejection while resolveEnvValues() hung forever.
 */
describe('unprocessed item resolve', () => {
  it('records a ResolutionError instead of throwing expected dataType to be set', async () => {
    const g = new EnvGraph();
    g.overrideValues = { REPRO_VAR: 'fixture-token-not-a-real-secret' };
    // Virtual files must be registered before setRootDataSource so the
    // container can feed overrideContents into each DotEnvFileDataSource.
    g.setVirtualImports('/virtual', {
      '.env.schema': 'REPRO_VAR=\n',
      '.env.local': 'VALID=ok\n@#$%^& this is not valid env syntax !!!\n',
    });
    await g.setRootDataSource(new MultiplePathsContainerDataSource([
      '/virtual/.env.schema',
      '/virtual/.env.local',
    ]));
    await g.finishLoad();

    const item = g.configSchema.REPRO_VAR;
    expect(item).toBeDefined();
    expect(item.dataType).toBeUndefined();

    const forwarded: Array<unknown> = [];
    const onRejection = (reason: unknown) => {
      forwarded.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    try {
      const settled = g.resolveEnvValues().then(
        () => 'RESOLVED' as const,
        (e: unknown) => e,
      );
      const result = await Promise.race([
        settled,
        new Promise<'STILL_PENDING'>((r) => setTimeout(() => r('STILL_PENDING'), 200)),
      ]);
      expect(result).toBe('RESOLVED');
      expect(
        forwarded.some((r) => String((r as Error)?.message ?? r).includes('expected dataType to be set')),
      ).toBe(false);
      expect(item.resolutionError).toBeInstanceOf(ResolutionError);
      expect(item.resolutionError?.message).toMatch(/expected dataType to be set/);
      expect(item.errors.length).toBeGreaterThan(0);
    } finally {
      process.removeListener('unhandledRejection', onRejection);
    }
  });
});
