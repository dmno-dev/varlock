import { describe, it, expect } from 'vitest';
import outdent from 'outdent';
import { EnvGraph } from '../index';
import { DotEnvFileDataSource } from '../lib/data-source';

describe('a dependency cycle next to an unrelated schema error', () => {
  it('is still reported, and resolving finishes', async () => {
    const g = new EnvGraph();
    await g.setRootDataSource(new DotEnvFileDataSource('.env.schema', {
      overrideContents: outdent`
        B=$B
        C=$Z
      `,
    }));
    await g.finishLoad();
    // without the cycle error on B, this promise never settles
    await g.resolveEnvValues();
    expect(g.configSchema.B.errors.map((e) => e.message)).toContain('Item cannot have dependency on itself');
    expect(g.configSchema.C.errors.map((e) => e.message)).toContain('ref(): invalid dependency: Z');
  }, 5000);
});
