import * as Config from 'effect/Config';
import * as ConfigProvider from 'effect/ConfigProvider';
import * as Data from 'effect/Data';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Redacted from 'effect/Redacted';
import {
  AlchemyContext, Stack, Stage, type Secrets,
} from 'alchemy';
import { SuppressMissingProviderConfig } from 'alchemy/Auth';
import { filterSerializedGraphKeys, type SerializedEnvGraph } from 'varlock';
import { execSyncVarlock, VarlockExecError } from 'varlock/exec-sync-varlock';
import { buildEnvBlobBindings } from 'varlock/env-blob';

const PROVIDER_TAG = '@varlock/alchemy-integration::Varlock';

/** Cloudflare Workers cap each secret at 5KB; the default blob chunk size */
const CLOUDFLARE_SECRET_MAX_BYTES = 5120;

/** The alchemy stack and stage a resolution is for. */
export interface AlchemyResolveContext {
  readonly stack: string | undefined;
  readonly stage: string;
  /** true under `alchemy dev` (local emulation) */
  readonly dev: boolean;
}

/** Options shared by the root schema and each service schema. */
export interface VarlockSchemaOptions {
  /**
   * Directory holding the `.env.schema` (and `.env*` files), relative to the directory alchemy
   * runs in. Defaults to the current directory.
   */
  path?: string;
  /**
   * varlock `--filter` expression (key globs, `!negations`, `@decorator`, `#tag`) limiting
   * which items are resolved and bound. Items outside the filter are not validated either.
   */
  filter?: string;
  /**
   * Which items become application bindings (and enter the `__VARLOCK_ENV` blob). Same syntax
   * as `--filter` (key globs, `!negations`, `#tags`, `@sensitive`, `@dynamic`), e.g. `"!#deploy"`
   * to keep deploy credentials tagged `@tag(deploy)` out of the Worker. Everything still reaches
   * alchemy's own `Config` reads. Default: every item.
   */
  bindingsFilter?: string;
  /**
   * Include the `__VARLOCK_ENV` runtime blob in the bindings so
   * `@varlock/cloudflare-integration/init` can boot varlock inside the Worker
   * (log redaction, leak detection, typed `ENV`). Default `true`, chunked for Cloudflare's 5KB
   * secret limit; pass `{ maxBytes }` for another platform's per-variable limit, or `false`.
   */
  blob?: boolean | { maxBytes?: number };
}

/** Env vars to expose to varlock while it resolves, derived from the alchemy stack, stage and mode. */
export type VarlockEnvHook = (ctx: AlchemyResolveContext) => Record<string, string | undefined>;

export interface VarlockSecretsOptions extends VarlockSchemaOptions {
  /**
   * Extra env vars to expose to varlock while it resolves. Use it to drive `@currentEnv`, e.g.
   * `env: ({ stage }) => ({ APP_ENV: stage === 'production' ? 'production' : 'preview' })`.
   * `ALCHEMY_STACK`, `ALCHEMY_STAGE` and `ALCHEMY_DEV` are always set, so the same mapping can
   * live in the schema instead: `APP_ENV=remap($ALCHEMY_STAGE, "production", production, /.*\/, preview)`.
   */
  env?: VarlockEnvHook;
}

export interface VarlockServicesOptions<ServiceName extends string> {
  /**
   * Schema for the deploy process itself (deploy credentials, shared config). Its items feed
   * alchemy's `Config` but are never offered as application bindings. Defaults to the current
   * directory; pass `false` if this package has no schema of its own.
   */
  root?: Pick<VarlockSchemaOptions, 'path' | 'filter'> | false;
  /** One schema per service, keyed by the name you pass to `bindingsFor()`. */
  services: Record<ServiceName, string | VarlockSchemaOptions>;
  env?: VarlockEnvHook;
}

/** Bindings that carry the varlock runtime blob (all uploaded as secrets except the chunk count). */
export type VarlockRuntimeBindings = {
  readonly __VARLOCK_ENV?: Config.Config<Redacted.Redacted<string>>;
  readonly __VARLOCK_ENV_CHUNKS?: Config.Config<string>;
  readonly _VARLOCK_ENV_KEY?: Config.Config<Redacted.Redacted<string>>;
} & {
  readonly [K: `__VARLOCK_ENV_${number}`]: Config.Config<Redacted.Redacted<string>>;
};

/**
 * Worker bindings for a schema, keyed like the schema. Types come from varlock's generated
 * types (`CoercedEnvSchema` in the schema's `env.d.ts`): pass that type as `Schema`.
 * Sensitive items are `Redacted` at deploy time and `secret_text` on the Worker; at runtime the
 * Worker sees plain values, which is what `Cloudflare.InferEnv` reports.
 */
export type VarlockBindings<Schema extends object> = {
  readonly [K in keyof Schema]-?: Config.Config<NonNullable<Schema[K]>>;
} & VarlockRuntimeBindings;

/** Any bindings record alchemy accepts on a resource's `env`. */
export type AnyVarlockBindings = Readonly<Record<string, Config.Config<unknown>>>;

/** Services the `bindings` accessor reads from the stack context. */
export type BindingsServices = Stage | AlchemyContext;

type SerializedItem = SerializedEnvGraph['config'][string];

function configError(message: string, cause?: unknown): Config.ConfigError {
  return new Config.ConfigError(new ConfigProvider.SourceError({ message, cause }));
}

function loadError(err: unknown): Config.ConfigError {
  if (err instanceof VarlockExecError) {
    // varlock already printed a full diagnosis to stderr (schema errors, missing required
    // items, failed resolvers); surface it instead of a generic message
    const detail = err.stderr.trim() || err.stdout.trim() || err.message;
    return configError(`varlock could not load the environment:\n${detail}`, err);
  }
  return configError(err instanceof Error ? err.message : String(err), err);
}

function loadGraph(opts: VarlockSchemaOptions, env: Record<string, string | undefined>): SerializedEnvGraph {
  // `@internal` items never appear in json-full, so they never reach alchemy at all
  let command = 'load --format json-full --compact';
  if (opts.filter) command += ` --filter=${JSON.stringify(opts.filter)}`;
  const { stdout } = execSyncVarlock(command, {
    fullResult: true,
    ...(opts.path ? { cwd: opts.path } : {}),
    env: { ...process.env, ...env },
    integrationTelemetry: {
      name: __VARLOCK_INTEGRATION_NAME__,
      version: __VARLOCK_INTEGRATION_VERSION__,
    },
  });
  return JSON.parse(stdout) as SerializedEnvGraph;
}

/** process.env-style string form of a resolved item */
function envString(item: SerializedItem): string {
  return item.envStr ?? (typeof item.value === 'string' ? item.value : JSON.stringify(item.value));
}

/** every resolved item, as the flat env alchemy's own Config reads see */
function providerValues(graph: SerializedEnvGraph): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, item] of Object.entries(graph.config)) {
    if (item.value === undefined || item.isInternal) continue;
    values[key] = envString(item);
  }
  return values;
}

/** the graph as the app runtime should see it: only items passing `bindingsFilter`, no inspection-only metadata */
function appGraph(graph: SerializedEnvGraph, bindingsFilter?: string): SerializedEnvGraph {
  const selected = bindingsFilter
    ? filterSerializedGraphKeys(graph.config, bindingsFilter, 'bindingsFilter')
    : undefined;
  const config: SerializedEnvGraph['config'] = {};
  for (const [key, item] of Object.entries(graph.config)) {
    if (item.isInternal) continue;
    if (selected && !selected.has(key)) continue;
    const { tags: _tags, ...rest } = item;
    config[key] = rest;
  }
  return { ...graph, config };
}

/** Worker bindings for one schema: values are literal Configs, so they never consult the provider */
function schemaBindings(graph: SerializedEnvGraph, opts: VarlockSchemaOptions): Record<string, Config.Config<unknown>> {
  const bindings: Record<string, Config.Config<unknown>> = {};
  const forApp = appGraph(graph, opts.bindingsFilter);
  for (const [key, item] of Object.entries(forApp.config)) {
    if (item.value === undefined) continue;
    if (item.isSensitive) {
      // Redacted -> secret_text
      bindings[key] = Config.succeed(Redacted.make(envString(item)));
    } else if (typeof item.value === 'boolean' || typeof item.value === 'number') {
      // json binding, so the Worker sees the coerced type
      bindings[key] = Config.succeed(item.value);
    } else {
      // string (composites as their env string form) -> plain_text
      bindings[key] = Config.succeed(envString(item));
    }
  }
  if (opts.blob !== false) {
    const blob = buildEnvBlobBindings({
      json: JSON.stringify(forApp),
      encryptInjectedEnv: forApp.settings?.encryptInjectedEnv,
      maxBytes: typeof opts.blob === 'object' ? opts.blob.maxBytes : CLOUDFLARE_SECRET_MAX_BYTES,
    });
    for (const [key, value] of Object.entries(blob)) {
      bindings[key] = key === '__VARLOCK_ENV_CHUNKS'
        ? Config.succeed(value)
        : Config.succeed(Redacted.make(value));
    }
  }
  return bindings;
}

/** what alchemy tells varlock about the run, plus the user's extra vars */
function contextEnv(ctx: AlchemyResolveContext, hook?: VarlockEnvHook) {
  return {
    ...(ctx.stack !== undefined ? { ALCHEMY_STACK: ctx.stack } : {}),
    ALCHEMY_STAGE: ctx.stage,
    ALCHEMY_DEV: ctx.dev ? 'true' : 'false',
    ...(hook?.(ctx) ?? {}),
  };
}

const resolveContext: Effect.Effect<AlchemyResolveContext, never, BindingsServices> = Effect.gen(function* step1() {
  const stage = yield* Stage;
  const alchemy = yield* AlchemyContext;
  const stack = yield* Effect.serviceOption(Stack);
  return {
    stage,
    dev: alchemy.dev,
    stack: Option.isSome(stack) ? stack.value.name : undefined,
  };
});

interface Resolved {
  /** the flat env every schema contributes to alchemy's Config */
  values: Record<string, string>;
  /** application bindings per service (`''` for a single schema) */
  bindings: Record<string, Record<string, Config.Config<unknown>>>;
}

/**
 * Shared machinery: a `secrets` provider whose layer resolves varlock once per stack session,
 * plus a per-session store the `bindings` accessor reads so the Worker bindings come from the
 * same resolution alchemy's Config reads did (a reload resolves again and replaces it).
 */
function makeProvider(resolve: (ctx: AlchemyResolveContext) => Resolved) {
  const sessions = new Map<string, Resolved>();
  const sessionKey = (ctx: AlchemyResolveContext) => `${ctx.stack ?? ''}|${ctx.stage}|${ctx.dev}`;

  const resolveSession = Effect.gen(function* step2() {
    const ctx = yield* resolveContext;
    const resolved = yield* Effect.try({ try: () => resolve(ctx), catch: loadError });
    sessions.set(sessionKey(ctx), resolved);
    return resolved;
  });

  const layer: Secrets.SecretsLayer = ConfigProvider.layerAdd(
    Effect.gen(function* step3() {
      // Auth-provider discovery (`alchemy login`) builds the stack just to find out which clouds
      // it uses; it must work before any credential varlock might need exists.
      if (yield* SuppressMissingProviderConfig) return ConfigProvider.fromEnv({ env: {} });
      const resolved = yield* resolveSession;
      const keys = Object.keys(resolved.values).sort();
      yield* Effect.logDebug(`Loaded ${keys.length} secrets from varlock: ${keys.join(', ')}`);
      return ConfigProvider.fromEnv({ env: resolved.values, preserveEmptyStrings: true });
    }),
    { asPrimary: true },
  );

  const bindingsFor = (service: string) => Effect.gen(function* step4() {
    const ctx = yield* resolveContext;
    const resolved = sessions.get(sessionKey(ctx)) ?? (yield* resolveSession);
    const bindings = resolved.bindings[service];
    if (!bindings) {
      return yield* Effect.fail(configError(
        `varlock: no schema named "${service}" in varlockServices({ services }); known: ${Object.keys(resolved.bindings).join(', ')}`,
      ));
    }
    return bindings;
  });

  return { layer, bindingsFor };
}

/** The `secrets` entry `varlock()` returns: a provider alchemy accepts, plus the typed bindings accessor. */
export class VarlockSecretsProvider<Bindings> extends Data.TaggedClass(PROVIDER_TAG)<{
  readonly layer: Secrets.SecretsLayer;
  /** Worker bindings for the schema, typed from its generated `CoercedEnvSchema` */
  readonly bindings: Effect.Effect<Bindings, Config.ConfigError, BindingsServices>;
}> {}

/**
 * Use varlock as the secret provider for an alchemy stack whose config lives in one
 * `.env.schema` (usually next to `alchemy.run.ts`).
 *
 * varlock resolves and validates the schema (plugins, `.env` files, `@currentEnv`) before
 * alchemy builds providers, and its values become the stack's Effect `Config` source. Every
 * schema item (or those passing `bindingsFilter`) is also offered as a typed Worker binding.
 *
 * @example
 * ```ts
 * import * as Alchemy from "alchemy";
 * import * as Cloudflare from "alchemy/Cloudflare";
 * import { varlock } from "@varlock/alchemy-integration";
 * import type { CoercedEnvSchema } from "./env.d.ts"; // generated by @generateTypes
 *
 * const env = varlock<CoercedEnvSchema>({ bindingsFilter: "!#deploy" });
 *
 * export default Alchemy.Stack("app", {
 *   providers: Cloudflare.providers(),
 *   state: Cloudflare.state(),
 *   secrets: env,
 * }, Effect.gen(function* step5() {
 *   const bindings = yield* env.bindings;
 *   return yield* Cloudflare.Worker("api", {
 *     main: "./src/worker.ts",
 *     env: { ...bindings, DB: db },
 *   });
 * }));
 * ```
 */
export function varlock<Schema extends object = Record<string, unknown>>(
  options: VarlockSecretsOptions = {},
): VarlockSecretsProvider<VarlockBindings<Schema>> {
  const { layer, bindingsFor } = makeProvider((ctx) => {
    const graph = loadGraph(options, contextEnv(ctx, options.env));
    return { values: providerValues(graph), bindings: { '': schemaBindings(graph, options) } };
  });
  return new VarlockSecretsProvider({
    layer,
    bindings: bindingsFor('') as Effect.Effect<VarlockBindings<Schema>, Config.ConfigError, BindingsServices>,
  });
}

/** The `secrets` entry `varlockServices()` returns: per-service bindings via `bindingsFor(name)`. */
export class VarlockServicesProvider<Schemas extends Record<string, object>> extends Data.TaggedClass(PROVIDER_TAG)<{
  readonly layer: Secrets.SecretsLayer;
  /** Worker bindings for one service, typed from that service's generated schema type. */
  readonly bindingsFor: <Name extends keyof Schemas & string>(
    service: Name,
  ) => Effect.Effect<VarlockBindings<Schemas[Name]>, Config.ConfigError, BindingsServices>;
}> {}

/**
 * Use varlock as the secret provider for a stack that deploys several services, each owning its
 * own `.env.schema` (a monorepo with `apps/server`, `apps/web`, ... and one `alchemy.run.ts`).
 *
 * The root schema (deploy credentials, shared config) plus every service schema feed the
 * stack's Effect `Config` (root wins on duplicate keys). Root items are never offered as
 * application bindings; each service gets its own bindings map and its own `__VARLOCK_ENV`
 * blob via `bindingsFor(name)`.
 *
 * @example
 * ```ts
 * const env = varlockServices<{ server: ServerEnv; web: WebEnv }>({
 *   services: { server: "../../apps/server", web: "../../apps/web" },
 * });
 * // ...
 * const server = yield* Cloudflare.Worker("server", {
 *   main: "../../apps/server/src/index.ts",
 *   env: { ...(yield* env.bindingsFor("server")), DB: db },
 * });
 * ```
 */
export function varlockServices<Schemas extends Record<string, object>>(
  options: VarlockServicesOptions<keyof Schemas & string>,
): VarlockServicesProvider<Schemas> {
  const { layer, bindingsFor } = makeProvider((ctx) => {
    const env = contextEnv(ctx, options.env);
    const values: Record<string, string> = {};
    const bindings: Resolved['bindings'] = {};
    if (options.root !== false) {
      // deploy-process config: feeds alchemy's Config, never a Worker
      Object.assign(values, providerValues(loadGraph(options.root ?? {}, env)));
    }
    for (const [name, service] of Object.entries<string | VarlockSchemaOptions>(options.services)) {
      const serviceOpts = typeof service === 'string' ? { path: service } : service;
      const graph = loadGraph(serviceOpts, env);
      // root (and earlier services) win on duplicate keys in the deploy-process view
      for (const [key, value] of Object.entries(providerValues(graph))) {
        if (!(key in values)) values[key] = value;
      }
      bindings[name] = schemaBindings(graph, serviceOpts);
    }
    return { values, bindings };
  });
  return new VarlockServicesProvider<Schemas>({
    layer,
    bindingsFor: (service) => bindingsFor(service) as Effect.Effect<
      VarlockBindings<Schemas[typeof service]>, Config.ConfigError, BindingsServices
    >,
  });
}
