import * as Config from 'effect/Config';
import * as ConfigProvider from 'effect/ConfigProvider';
import * as Data from 'effect/Data';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Redacted from 'effect/Redacted';
import {
  AlchemyContext, Stack, Stage, type Secrets as AlchemySecrets,
} from 'alchemy';
import { SuppressMissingProviderConfig } from 'alchemy/Auth';
import { filterSerializedGraphKeys, type SerializedEnvGraph } from 'varlock';
import { execSyncVarlock, VarlockExecError } from 'varlock/exec-sync-varlock';
import { buildEnvBlobBindings } from 'varlock/env-blob';

const PROVIDER_TAG = '@varlock/alchemy-integration::Varlock';

/** Cloudflare Workers cap each secret at 5KB; the default blob chunk size */
const CLOUDFLARE_SECRET_MAX_BYTES = 5120;

/**
 * Variables alchemy binds into every Worker itself (and skips on deploy when `env` repeats
 * them). Schema items with these names stay in the `__VARLOCK_ENV` blob but are not bound again.
 */
const ALCHEMY_RUNTIME_KEYS = new Set(['ALCHEMY_PHASE', 'ALCHEMY_WORKER_NAME', 'ALCHEMY_STACK_NAME', 'ALCHEMY_STAGE', 'ALCHEMY_CLOUDFLARE_ACCOUNT_ID']);

/** The alchemy stack and stage a resolution is for. */
interface AlchemyResolveContext {
  readonly stack: string | undefined;
  readonly stage: string;
  /** true under `alchemy dev` (local emulation) */
  readonly dev: boolean;
}

/** Options shared by the single schema and each service schema. */
export interface VarlockSchemaOptions {
  /**
   * Directory holding the `.env.schema` (and `.env*` files), relative to the directory alchemy
   * runs in. Defaults to the current directory.
   */
  path?: string;
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
   * (log redaction, leak detection, typed `ENV`). Default `true`; a blob over Cloudflare's 5KB
   * secret limit is split into chunks.
   */
  blob?: boolean;
}

export type VarlockSecretsOptions = VarlockSchemaOptions;

export interface VarlockServicesOptions<ServiceName extends string> {
  /**
   * Schema for the deploy process itself (deploy credentials, shared config). Its items feed
   * alchemy's `Config` but are never offered as application bindings. Defaults to the current
   * directory; pass `false` if this package has no schema of its own.
   */
  root?: Pick<VarlockSchemaOptions, 'path'> | false;
  /** One schema per service, keyed by the name you pass to `bindingsFor()`. */
  services: Record<ServiceName, string | VarlockSchemaOptions>;
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
 * What a Worker receives for a schema item: strings, numbers and booleans keep their coerced
 * type (numbers and booleans upload as JSON bindings); arrays and objects arrive in their
 * process.env string form (the same string `varlock run` would inject), since a sensitive
 * composite can only travel as a `secret_text` string. Use the varlock runtime's `ENV` for
 * the parsed value.
 */
export type BindingValue<T> = T extends string | number | boolean ? T : string;

/**
 * Worker bindings for a schema, keyed like the schema. Types come from varlock's generated
 * types (`CoercedEnvSchema` in the schema's `env.d.ts`): pass that type as `Schema`.
 * Sensitive items are `Redacted` at deploy time and `secret_text` on the Worker; at runtime the
 * Worker sees plain values, which is what `Cloudflare.InferEnv` reports.
 *
 * Optional schema items stay optional: an item that resolves to no value is not bound. Types
 * cannot see `bindingsFilter`, so leave the keys it removes out of `Schema` yourself
 * (`Omit<CoercedEnvSchema, 'CLOUDFLARE_API_TOKEN'>`), or the Worker's `Env` will list them.
 */
export type VarlockBindings<Schema extends object> = {
  readonly [K in keyof Schema]: Config.Config<BindingValue<NonNullable<Schema[K]>>>;
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

function loadGraph(opts: Pick<VarlockSchemaOptions, 'path'>, env: Record<string, string>): SerializedEnvGraph {
  // `@internal` items never appear in json-full, so they never reach alchemy at all
  const { stdout } = execSyncVarlock('load --format json-full --compact', {
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

/**
 * the graph as the app runtime should see it: only items passing `bindingsFilter`, no
 * inspection-only metadata, and nothing tied to the machine that ran alchemy. `basePath` and
 * `sources` (absolute paths in labels, file `contentHash`es) only serve local tooling; left in,
 * they would put the deployer's home directory into the Worker and make the blob, and so the
 * Worker's secrets, differ between a laptop and CI or after a comment-only edit.
 */
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
  const { basePath: _basePath, ...portable } = graph;
  // the blob always ships unencrypted (see schemaBindings), so say so
  const settings = { ...graph.settings, encryptInjectedEnv: false };
  return {
    ...portable, sources: [], settings, config,
  };
}

/** Worker bindings for one schema: values are literal Configs, so they never consult the provider */
function schemaBindings(graph: SerializedEnvGraph, opts: VarlockSchemaOptions): Record<string, Config.Config<unknown>> {
  const bindings: Record<string, Config.Config<unknown>> = {};
  const forApp = appGraph(graph, opts.bindingsFilter);
  for (const [key, item] of Object.entries(forApp.config)) {
    if (item.value === undefined || ALCHEMY_RUNTIME_KEYS.has(key)) continue;
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
    // `@encryptInjectedEnv` protects a blob baked into build output. Here the blob is a Worker
    // secret and the key would be another secret beside it, so encryption protects nothing; it
    // would only change the ciphertext (fresh nonce and key) and redeploy secrets every run.
    const blob = buildEnvBlobBindings({
      json: JSON.stringify(forApp),
      plaintext: true,
      maxBytes: CLOUDFLARE_SECRET_MAX_BYTES,
    });
    for (const [key, value] of Object.entries(blob)) {
      bindings[key] = key === '__VARLOCK_ENV_CHUNKS'
        ? Config.succeed(value)
        : Config.succeed(Redacted.make(value));
    }
  }
  return bindings;
}

/**
 * what alchemy tells varlock about the run, under the names alchemy itself binds into Workers
 * (`ALCHEMY_STACK_NAME`, `ALCHEMY_STAGE`) plus `ALCHEMY_DEV`. The deploy process never has the
 * resolved stage in its env (alchemy only reads `$ALCHEMY_STAGE` as a default), so it is passed here.
 */
function contextEnv(ctx: AlchemyResolveContext): Record<string, string> {
  return {
    ...(ctx.stack !== undefined ? { ALCHEMY_STACK_NAME: ctx.stack } : {}),
    ALCHEMY_STAGE: ctx.stage,
    ALCHEMY_DEV: ctx.dev ? 'true' : 'false',
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

  const layer: AlchemySecrets.SecretsLayer = ConfigProvider.layerAdd(
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
        `varlock: no schema named "${service}" in Secrets({ services }); known: ${Object.keys(resolved.bindings).join(', ')}`,
      ));
    }
    return bindings;
  });

  return { layer, bindingsFor };
}

/** The `secrets` entry `Secrets()` returns for one schema: a provider alchemy accepts, plus the typed bindings accessor. */
export class VarlockSecretsProvider<Bindings> extends Data.TaggedClass(PROVIDER_TAG)<{
  readonly layer: AlchemySecrets.SecretsLayer;
  /** Worker bindings for the schema, typed from its generated `CoercedEnvSchema` */
  readonly bindings: Effect.Effect<Bindings, Config.ConfigError, BindingsServices>;
}> {}

function singleSchema<Schema extends object>(
  options: VarlockSecretsOptions,
): VarlockSecretsProvider<VarlockBindings<Schema>> {
  const { layer, bindingsFor } = makeProvider((ctx) => {
    const graph = loadGraph(options, contextEnv(ctx));
    return { values: providerValues(graph), bindings: { '': schemaBindings(graph, options) } };
  });
  return new VarlockSecretsProvider({
    layer,
    bindings: bindingsFor('') as Effect.Effect<VarlockBindings<Schema>, Config.ConfigError, BindingsServices>,
  });
}

/** The `secrets` entry `Secrets({ services })` returns: per-service bindings via `bindingsFor(name)`. */
export class VarlockServicesProvider<Schemas extends Record<string, object>> extends Data.TaggedClass(PROVIDER_TAG)<{
  readonly layer: AlchemySecrets.SecretsLayer;
  /** Worker bindings for one service, typed from that service's generated schema type. */
  readonly bindingsFor: <Name extends keyof Schemas & string>(
    service: Name,
  ) => Effect.Effect<VarlockBindings<Schemas[Name]>, Config.ConfigError, BindingsServices>;
}> {}

function multiSchema<Schemas extends Record<string, object>>(
  options: VarlockServicesOptions<keyof Schemas & string>,
): VarlockServicesProvider<Schemas> {
  const { layer, bindingsFor } = makeProvider((ctx) => {
    const env = contextEnv(ctx);
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

/**
 * Use varlock as the secrets provider for an alchemy stack.
 *
 * With one `.env.schema` (usually next to `alchemy.run.ts`), varlock resolves and validates it
 * (plugins, `.env` files, `@currentEnv`) before alchemy builds providers, its values become the
 * stack's Effect `Config` source, and every schema item (or those passing `bindingsFilter`) is
 * offered as a typed Worker binding through `.bindings`.
 *
 * With `services`, each service owns its own schema (a monorepo with `apps/server`, `apps/web`,
 * ... and one `alchemy.run.ts`). The root schema (deploy credentials, shared config) plus every
 * service schema feed the stack's `Config` (root wins on duplicate keys); root items are never
 * offered as bindings, and each service gets its own bindings map and `__VARLOCK_ENV` blob
 * through `.bindingsFor(name)`.
 *
 * @example
 * ```ts
 * import * as Alchemy from "alchemy";
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Varlock from "@varlock/alchemy-integration";
 * import type { CoercedEnvSchema } from "./env.d.ts"; // generated by @generateTypes
 *
 * // keys removed by bindingsFilter are omitted from the type too, so the Worker's Env matches
 * type AppEnv = Omit<CoercedEnvSchema, "CLOUDFLARE_ACCOUNT_ID" | "CLOUDFLARE_API_TOKEN">;
 * const env = Varlock.Secrets<AppEnv>({ bindingsFilter: "!#deploy" });
 *
 * export default Alchemy.Stack("app", {
 *   providers: Cloudflare.providers(),
 *   state: Cloudflare.state(),
 *   secrets: env,
 * }, Effect.gen(function* () {
 *   return yield* Cloudflare.Worker("api", {
 *     main: "./src/worker.ts",
 *     env: { ...(yield* env.bindings), DB: db },
 *   });
 * }));
 * ```
 *
 * @example
 * ```ts
 * const env = Varlock.Secrets<{ server: ServerEnv; web: WebEnv }>({
 *   services: { server: "../../apps/server", web: "../../apps/web" },
 * });
 * // ...
 * env: { ...(yield* env.bindingsFor("server")), DB: db }
 * ```
 */
export function Secrets<Schemas extends Record<string, object>>(
  options: VarlockServicesOptions<keyof Schemas & string>,
): VarlockServicesProvider<Schemas>;
export function Secrets<Schema extends object = Record<string, unknown>>(
  options?: VarlockSecretsOptions,
): VarlockSecretsProvider<VarlockBindings<Schema>>;
export function Secrets(options: VarlockSecretsOptions | VarlockServicesOptions<string> = {}) {
  return 'services' in options ? multiSchema(options) : singleSchema(options);
}
