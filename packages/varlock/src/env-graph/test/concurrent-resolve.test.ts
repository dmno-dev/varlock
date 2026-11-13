import {
  describe, it, expect, vi,
} from 'vitest';
import outdent from 'outdent';
import { EnvGraph } from '../index';
import { DotEnvFileDataSource } from '../lib/data-source';

// With a schema error anywhere, finishLoad does not resolve the root decorators, so the
// @currentEnv item is first resolved by the forEnv() calls, which all run in parallel.
describe('an item reached by several resolvers at once', () => {
  async function loadGraph() {
    const g = new EnvGraph();
    await g.setRootDataSource(new DotEnvFileDataSource('.env.schema', {
      overrideContents: outdent`
        # @currentEnv=$APP_ENV
        # @defaultSensitive=false
        # ---
        # @type=enum(dev, prod)
        APP_ENV=dev
        # @required=forEnv(prod)
        API_URL=
        # @required=forEnv(prod)
        DB_URL=
        # @reqired
        PORT=3000
      `,
    }));
    await g.finishLoad();
    return g;
  }

  it('resolves its value once', async () => {
    const g = await loadGraph();
    const resolveSpy = vi.spyOn(g.configSchema.APP_ENV.valueResolver!, 'resolve');
    await g.resolveEnvValues();
    expect(resolveSpy).toHaveBeenCalledTimes(1);
  });

  it('is validated once, so it gets no repeated warnings', async () => {
    const g = await loadGraph();
    await g.resolveEnvValues();
    const messages = g.configSchema.APP_ENV.errors.map((e) => e.message);
    expect(new Set(messages).size).toBe(messages.length);
  });

  // an item can also reach itself: the env item's own metadata asks for the env, which resolves the env item
  it.each([
    ['on the @currentEnv item', '# @type=enum(dev, prod) @required=forEnv(prod)\nAPP_ENV=dev'],
    ['on an item the @currentEnv item is built from', '# @required=forEnv(prod)\nBASE=dev\nAPP_ENV=$BASE'],
  ])('a forEnv() decorator %s does not wait for itself', async (_label, items) => {
    const g = new EnvGraph();
    await g.setRootDataSource(new DotEnvFileDataSource('.env.schema', {
      overrideContents: `# @currentEnv=$APP_ENV\n# @defaultSensitive=false\n# ---\n${items}\n`,
    }));
    await g.finishLoad();
    await g.resolveEnvValues();
    expect(g.configSchema.APP_ENV.resolvedValue).toBe('dev');
    expect(g.configSchema.APP_ENV.errors.filter((e) => !e.isWarning)).toEqual([]);
  }, 5000);
});
