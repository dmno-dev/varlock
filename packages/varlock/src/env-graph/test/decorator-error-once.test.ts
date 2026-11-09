import { describe, it, expect } from 'vitest';
import outdent from 'outdent';
import { EnvGraph } from '../index';
import { DotEnvFileDataSource } from '../lib/data-source';

describe('a decorator whose resolver throws', () => {
  it('reports the error once', async () => {
    const g = new EnvGraph();
    await g.setRootDataSource(new DotEnvFileDataSource('.env.schema', {
      overrideContents: outdent`
        # @currentEnv=$APP_ENV
        # @defaultRequired=false
        # ---
        # @type=enum(dev, prod)
        APP_ENV=
        # @required=forEnv(prod)
        API_URL=
      `,
    }));
    await g.finishLoad();
    await g.resolveEnvValues();
    expect(g.configSchema.API_URL.errors.map((e) => e.message)).toEqual(['forEnv(): current environment is not set']);
  });
});
