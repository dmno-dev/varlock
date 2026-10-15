import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { AlchemyContext, Stack, Stage } from 'alchemy';
import * as Config from 'effect/Config';
import * as ConfigProvider from 'effect/ConfigProvider';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';
import { Secrets } from '../src/index';

const fixtures = path.join(import.meta.dirname, 'fixtures');

/** the services alchemy gives a secrets provider, as a layer */
function stackServices(stage: string, dev = false) {
  return Layer.mergeAll(
    Layer.succeed(Stage, stage),
    Layer.succeed(AlchemyContext, { dev, dotAlchemy: '.alchemy', adopt: false } as AlchemyContext['Service']),
    Layer.succeed(Stack, { name: 'app' } as Stack['Service']),
    // what the entries below ours assembled (alchemy starts the chain with an empty provider)
    ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
  );
}

/**
 * Run a provider the way alchemy's stackConfigLayer does: build its layer over the stack
 * services, then run `effect` with the resulting ConfigProvider and the same services.
 */
async function withProvider<A>(
  provider: { layer: Layer.Layer<never, unknown, any> },
  opts: { stage: string; dev?: boolean },
  effect: Effect.Effect<A, unknown, any>,
): Promise<A> {
  const services = stackServices(opts.stage, opts.dev);
  const program = Effect.gen(function* run1() {
    const built = yield* Layer.build(provider.layer.pipe(Layer.provide(services)));
    const configProvider = Context.get(built, ConfigProvider.ConfigProvider);
    return yield* effect.pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, configProvider),
      Effect.provide(services),
    );
  }).pipe(Effect.scoped);
  return Effect.runPromise(program as unknown as Effect.Effect<A, unknown>);
}

const value = <A>(config: Config.Config<A>) => Effect.runPromise(config as Effect.Effect<A, unknown>);
const blobOf = async (bindings: Record<string, Config.Config<unknown>>) => JSON.parse(
  Redacted.value(await value(bindings.__VARLOCK_ENV) as Redacted.Redacted<string>),
);

describe('Secrets()', () => {
  const env = Secrets({ path: path.join(fixtures, 'server') });

  it('feeds alchemy Config from the resolved schema and exposes typed bindings', async () => {
    const { cors, stageSeen, bindings } = await withProvider(env, { stage: 'dev_test', dev: true }, Effect.gen(function* run2() {
      return {
        cors: yield* Config.String('CORS_ORIGIN'),
        // ALCHEMY_STAGE is visible to the schema while it resolves
        stageSeen: yield* Config.String('STAGE_SEEN'),
        bindings: yield* env.bindings,
      };
    }));
    expect(cors).toBe('http://localhost:4321');
    expect(stageSeen).toBe('dev_test');

    const secret = await value(bindings.BETTER_AUTH_SECRET) as unknown;
    expect(Redacted.isRedacted(secret)).toBe(true);
    expect(Redacted.value(secret as Redacted.Redacted<string>)).toBe('server-secret-value-long');
    expect(await value(bindings.CORS_ORIGIN)).toBe('http://localhost:4321');
    // coerced types survive as json bindings
    expect(await value(bindings.FEATURE_FLAG)).toBe(true);
    // the runtime blob rides along as a secret and never contains inspection-only metadata
    const blob = await blobOf(bindings);
    expect(Object.keys(blob.config).sort()).toEqual([
      'ALCHEMY_DEV',
      'ALCHEMY_STACK',
      'ALCHEMY_STAGE',
      'APP_ENV',
      'BETTER_AUTH_SECRET',
      'CORS_ORIGIN',
      'DEPLOY_HOOK_TOKEN',
      'DEV_SEEN',
      'FEATURE_FLAG',
      'SHARED',
      'STAGE_SEEN',
      'VARLOCK_ENV',
    ]);
    expect(blob.config.BETTER_AUTH_SECRET.tags).toBeUndefined();
  });

  it('sets VARLOCK_ENV from the stage and mode so @currentEnv needs no mapping', async () => {
    const cors = (opts: { stage: string; dev?: boolean }) => withProvider(env, opts, Config.String('CORS_ORIGIN'));
    expect(await cors({ stage: 'dev_test', dev: true })).toBe('http://localhost:4321'); // development
    expect(await cors({ stage: 'dev_test' })).toBe('https://preview.example.com');
    expect(await cors({ stage: 'pr-42' })).toBe('https://preview.example.com');
    expect(await cors({ stage: 'production' })).toBe('https://prod.example.com');
    expect(await withProvider(env, { stage: 'staging' }, Config.String('VARLOCK_ENV'))).toBe('staging');
  });

  it('can leave VARLOCK_ENV to varlock itself', async () => {
    const own = Secrets({ path: path.join(fixtures, 'server'), varlockEnv: false });
    // varlock's own detection (test under vitest, development outside CI), whatever the alchemy stage
    const detected = await withProvider(own, { stage: 'production' }, Config.String('VARLOCK_ENV'));
    expect(detected).not.toBe('production');
    expect(detected).toMatch(/^(development|test)$/);
  });

  it('lets the env hook override the derived VARLOCK_ENV', async () => {
    const pinned = Secrets({ path: path.join(fixtures, 'server'), env: () => ({ VARLOCK_ENV: 'production' }) });
    const { cors, bindings } = await withProvider(pinned, { stage: 'dev_test' }, Effect.gen(function* run3() {
      return { cors: yield* Config.String('CORS_ORIGIN'), bindings: yield* pinned.bindings };
    }));
    expect(cors).toBe('https://prod.example.com');
    expect(await value(bindings.CORS_ORIGIN)).toBe('https://prod.example.com');
  });

  it('tells the schema whether this is alchemy dev', async () => {
    const dev = await withProvider(env, { stage: 'dev_test', dev: true }, Config.String('DEV_SEEN'));
    const live = await withProvider(env, { stage: 'dev_test', dev: false }, Config.String('DEV_SEEN'));
    expect(dev).toBe('true');
    expect(live).toBe('false');
  });

  it('can leave the blob out', async () => {
    const noBlob = Secrets({ path: path.join(fixtures, 'server'), blob: false });
    const bindings = await withProvider(noBlob, { stage: 'x' }, noBlob.bindings);
    expect(bindings.__VARLOCK_ENV).toBeUndefined();
  });

  it('surfaces varlock diagnostics as a ConfigError', async () => {
    const broken = Secrets({ path: path.join(fixtures, 'invalid') });
    await expect(withProvider(broken, { stage: 'x' }, Effect.void))
      .rejects.toThrow(/varlock could not load[\s\S]*MUST_BE_SET/);
  });
});

describe('filter', () => {
  it('scopes resolution with key globs and negated tags, passed to the CLI unquoted', async () => {
    const keys = Secrets({ path: path.join(fixtures, 'server'), filter: 'BETTER_*, CORS_ORIGIN' });
    const narrowed = await withProvider(keys, { stage: 'x' }, keys.bindings);
    expect(Object.keys(narrowed).sort()).toEqual(['BETTER_AUTH_SECRET', 'CORS_ORIGIN', '__VARLOCK_ENV']);

    const noDeploy = Secrets({ path: path.join(fixtures, 'server'), filter: '!#deploy' });
    const { hook, bindings } = await withProvider(noDeploy, { stage: 'x' }, Effect.gen(function* run() {
      return { hook: yield* Config.option(Config.String('DEPLOY_HOOK_TOKEN')), bindings: yield* noDeploy.bindings };
    }));
    // unlike bindingsFilter, a filter keeps the item out of alchemy's Config too
    expect(hook._tag).toBe('None');
    expect(bindings.DEPLOY_HOOK_TOKEN).toBeUndefined();
    expect(bindings.BETTER_AUTH_SECRET).toBeDefined();
  });

  it('rejects anything outside the filter grammar before running varlock', async () => {
    const bad = Secrets({ path: path.join(fixtures, 'server'), filter: 'A; rm -rf /' });
    await expect(withProvider(bad, { stage: 'x' }, Effect.void)).rejects.toThrow(/invalid filter expression/);
  });
});

describe('composite values', () => {
  it('bind as their env string form, with coerced numbers and booleans kept', async () => {
    const env = Secrets({ path: path.join(fixtures, 'composite') });
    const bindings = await withProvider(env, { stage: 'x' }, env.bindings);
    expect(await value(bindings.LIST)).toBe('one,two');
    expect(await value(bindings.OBJ)).toBe('{"a":1}');
    expect(Redacted.value(await value(bindings.SECRET_LIST) as unknown as Redacted.Redacted<string>)).toBe('key-one-long,key-two-long');
    expect(await value(bindings.COUNT)).toBe(3);
    // the blob keeps the parsed values for the varlock runtime's ENV
    const blob = await blobOf(bindings);
    expect(blob.config.LIST.value).toEqual(['one', 'two']);
  });
});

describe('bindingsFilter and @internal', () => {
  it('bindingsFilter keeps tagged items out of the bindings and blob but not the provider', async () => {
    const env = Secrets({ path: path.join(fixtures, 'server'), bindingsFilter: '!#deploy' });
    const { hook, bindings } = await withProvider(env, { stage: 'x' }, Effect.gen(function* run4() {
      return { hook: yield* Config.String('DEPLOY_HOOK_TOKEN'), bindings: yield* env.bindings };
    }));
    expect(hook).toBe('deploy-hook-value-long');
    expect(bindings.DEPLOY_HOOK_TOKEN).toBeUndefined();
    expect(bindings.BETTER_AUTH_SECRET).toBeDefined();
    const blob = await blobOf(bindings);
    expect(blob.config).not.toHaveProperty('DEPLOY_HOOK_TOKEN');
    expect(blob.config).toHaveProperty('BETTER_AUTH_SECRET');
  });

  it('@internal items reach neither the provider nor the bindings', async () => {
    const env = Secrets({ path: path.join(fixtures, 'root') });
    const { token, op, bindings } = await withProvider(env, { stage: 'x' }, Effect.gen(function* run5() {
      return {
        token: yield* Config.String('CLOUDFLARE_API_TOKEN'),
        op: yield* Config.option(Config.String('OP_TOKEN')),
        bindings: yield* env.bindings,
      };
    }));
    expect(token).toBe('cf-token-value-long-enough');
    expect(op._tag).toBe('None');
    expect(bindings).not.toHaveProperty('OP_TOKEN');
  });
});

describe('Secrets({ services })', () => {
  type Schemas = {
    server: { BETTER_AUTH_SECRET: string; CORS_ORIGIN: string };
    web: { PUBLIC_SERVER_URL: string };
  };
  const env = Secrets<Schemas>({
    root: { path: path.join(fixtures, 'root') },
    services: {
      server: path.join(fixtures, 'server'),
      web: { path: path.join(fixtures, 'web') },
    },
  });

  it('merges every schema into the provider with the root winning duplicates', async () => {
    const values = await withProvider(env, { stage: 'dev_test' }, Effect.all({
      token: Config.String('CLOUDFLARE_API_TOKEN'),
      secret: Config.String('BETTER_AUTH_SECRET'),
      url: Config.String('PUBLIC_SERVER_URL'),
      shared: Config.String('SHARED'),
    }));
    expect(values).toEqual({
      token: 'cf-token-value-long-enough',
      secret: 'server-secret-value-long',
      url: 'http://localhost:3000',
      shared: 'root-shared',
    });
  });

  it('bindingsFor() returns one service with its own blob; root items are never bound', async () => {
    const { server, web } = await withProvider(env, { stage: 'dev_test' }, Effect.all({
      server: env.bindingsFor('server'),
      web: env.bindingsFor('web'),
    }));
    expect(Object.keys(server).sort()).toEqual([
      'ALCHEMY_DEV',
      'ALCHEMY_STACK',
      'ALCHEMY_STAGE',
      'APP_ENV',
      'BETTER_AUTH_SECRET',
      'CORS_ORIGIN',
      'DEPLOY_HOOK_TOKEN',
      'DEV_SEEN',
      'FEATURE_FLAG',
      'SHARED',
      'STAGE_SEEN',
      'VARLOCK_ENV',
      '__VARLOCK_ENV',
    ]);
    expect(Object.keys(web).sort()).toEqual(['PUBLIC_SERVER_URL', '__VARLOCK_ENV']);
    expect(server).not.toHaveProperty('CLOUDFLARE_API_TOKEN');
    expect((await blobOf(server)).config).toHaveProperty('BETTER_AUTH_SECRET');
    expect((await blobOf(web as never)).config).not.toHaveProperty('BETTER_AUTH_SECRET');
  });

  it('rejects an unknown service name', async () => {
    await expect(withProvider(env, { stage: 'dev_test' }, env.bindingsFor('nope' as never)))
      .rejects.toThrow(/no schema named "nope"/);
  });
});
