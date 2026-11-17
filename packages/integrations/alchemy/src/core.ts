import * as Config from 'effect/Config';
import * as ConfigProvider from 'effect/ConfigProvider';
import * as Data from 'effect/Data';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import {
  AlchemyContext, Stack, Stage, type Secrets as AlchemySecrets,
} from 'alchemy';
import { SuppressMissingProviderConfig } from 'alchemy/Auth';
import { filterSerializedGraphKeys, type SerializedEnvGraph } from 'varlock';
import { execSyncVarlock, VarlockExecError } from 'varlock/exec-sync-varlock';

const PROVIDER_TAG = '@varlock/alchemy-integration::Varlock';

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
   * Which items the application receives (as bindings, env vars, and in the `__VARLOCK_ENV`
   * blob). Same syntax as `--filter` (key globs, `!negations`, `#tags`, `@sensitive`,
   * `@dynamic`), e.g. `"!#deploy"` to keep deploy credentials tagged `@tag(deploy)` out of the
   * app. Everything still reaches alchemy's own `Config` reads. Default: every item.
   */
  bindingsFilter?: string;
}

export type VarlockSecretsOptions = VarlockSchemaOptions;

export interface VarlockServicesOptions<ServiceName extends string> {
  /**
   * Schema for the deploy process itself (deploy credentials, shared config). Its items feed
   * alchemy's `Config` but never reach an application. Defaults to the current directory; pass
   * `false` if this package has no schema of its own.
   */
  root?: Pick<VarlockSchemaOptions, 'path'> | false;
  /** One schema per service, keyed by the name you pass to a target adapter. */
  services: Record<ServiceName, string | VarlockSchemaOptions>;
}

/** Services a target adapter reads from the stack context. */
export type BindingsServices = Stage | AlchemyContext;

export type SerializedItem = SerializedEnvGraph['config'][string];

export function configError(message: string, cause?: unknown): Config.ConfigError {
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
export function envString(item: SerializedItem): string {
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
 * the graph as the application should see it: only items passing `bindingsFilter`, no
 * inspection-only metadata, and nothing tied to the machine that ran alchemy. `basePath` and
 * `sources` (absolute paths in labels, file `contentHash`es) only serve local tooling; left in,
 * they would put the deployer's home directory into the app and make the blob differ between a
 * laptop and CI or after a comment-only edit. `settings` are kept as resolved; each target
 * adapter decides what they mean for its delivery.
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
  return { ...portable, sources: [], config };
}

/**
 * what alchemy tells varlock about the run, under the names alchemy itself injects into
 * runtimes (`ALCHEMY_STACK_NAME`, `ALCHEMY_STAGE`) plus `ALCHEMY_DEV`. The deploy process never
 * has the resolved stage in its env (alchemy only reads `$ALCHEMY_STAGE` as a default), so it is
 * passed here.
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
  /** the application graph per service (`''` for a single schema) */
  graphs: Record<string, SerializedEnvGraph>;
}

/** reads one service's application graph from the session the provider resolved */
type AppGraphAccessor = (service: string) => Effect.Effect<SerializedEnvGraph, Config.ConfigError, BindingsServices>;

/** provider -> accessor; kept off the public type so only target adapters in this package use it */
const appGraphAccessors = new WeakMap<object, AppGraphAccessor>();

/**
 * The application graph for one service (`''` for a single schema), from the same resolution
 * alchemy's Config reads used. Target adapters turn it into their platform's delivery.
 */
export function appGraphFor(
  provider: object,
  service: string,
): Effect.Effect<SerializedEnvGraph, Config.ConfigError, BindingsServices> {
  const accessor = appGraphAccessors.get(provider);
  if (!accessor) {
    return Effect.fail(configError('varlock: expected a provider returned by Varlock.Secrets()'));
  }
  return accessor(service);
}

/**
 * Shared machinery: a `secrets` provider whose layer resolves varlock once per stack session,
 * plus a per-session store the target adapters read so what the app receives comes from the
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

  const graphFor: AppGraphAccessor = (service) => Effect.gen(function* step4() {
    const ctx = yield* resolveContext;
    const resolved = sessions.get(sessionKey(ctx)) ?? (yield* resolveSession);
    const graph = resolved.graphs[service];
    if (!graph) {
      return yield* Effect.fail(configError(
        `varlock: no schema named "${service}" in Secrets({ services }); known: ${Object.keys(resolved.graphs).join(', ')}`,
      ));
    }
    return graph;
  });

  return { layer, graphFor };
}

/** type-only fields that carry the schema type(s) and keep the two provider kinds apart */
declare const schemaType: unique symbol;
declare const servicesType: unique symbol;

/**
 * The `secrets` entry `Secrets()` returns for one schema. Pass it to alchemy's `secrets`, and to
 * a target adapter (`VarlockCloudflare.bindings(env)`) for what the app receives.
 */
export class VarlockSecretsProvider<Schema extends object> extends Data.TaggedClass(PROVIDER_TAG)<{
  readonly layer: AlchemySecrets.SecretsLayer;
}> {
  declare readonly [schemaType]: Schema;
}

/**
 * The `secrets` entry `Secrets({ services })` returns. Target adapters take it plus a service
 * name (`VarlockCloudflare.bindings(env, "server")`).
 */
export class VarlockServicesProvider<Schemas extends Record<string, object>> extends Data.TaggedClass(PROVIDER_TAG)<{
  readonly layer: AlchemySecrets.SecretsLayer;
}> {
  declare readonly [servicesType]: Schemas;
}

function singleSchema<Schema extends object>(options: VarlockSecretsOptions): VarlockSecretsProvider<Schema> {
  const { layer, graphFor } = makeProvider((ctx) => {
    const graph = loadGraph(options, contextEnv(ctx));
    return { values: providerValues(graph), graphs: { '': appGraph(graph, options.bindingsFilter) } };
  });
  const provider = new VarlockSecretsProvider<Schema>({ layer });
  appGraphAccessors.set(provider, graphFor);
  return provider;
}

function multiSchema<Schemas extends Record<string, object>>(
  options: VarlockServicesOptions<keyof Schemas & string>,
): VarlockServicesProvider<Schemas> {
  const { layer, graphFor } = makeProvider((ctx) => {
    const env = contextEnv(ctx);
    const values: Record<string, string> = {};
    const graphs: Resolved['graphs'] = {};
    if (options.root !== false) {
      // deploy-process config: feeds alchemy's Config, never an application
      Object.assign(values, providerValues(loadGraph(options.root ?? {}, env)));
    }
    for (const [name, service] of Object.entries<string | VarlockSchemaOptions>(options.services)) {
      const serviceOpts = typeof service === 'string' ? { path: service } : service;
      const graph = loadGraph(serviceOpts, env);
      // root (and earlier services) win on duplicate keys in the deploy-process view
      for (const [key, value] of Object.entries(providerValues(graph))) {
        if (!(key in values)) values[key] = value;
      }
      graphs[name] = appGraph(graph, serviceOpts.bindingsFilter);
    }
    return { values, graphs };
  });
  const provider = new VarlockServicesProvider<Schemas>({ layer });
  appGraphAccessors.set(provider, graphFor);
  return provider;
}

/**
 * Use varlock as the secrets provider for an alchemy stack, on any platform alchemy deploys to.
 *
 * With one `.env.schema` (usually next to `alchemy.run.ts`), varlock resolves and validates it
 * (plugins, `.env` files, `@currentEnv`) before alchemy builds providers, and its values become
 * the stack's Effect `Config` source. A target adapter turns the items passing `bindingsFilter`
 * into what the app receives (Cloudflare: `@varlock/alchemy-integration/cloudflare`).
 *
 * With `services`, each service owns its own schema (a monorepo with `apps/server`, `apps/web`,
 * ... and one `alchemy.run.ts`). The root schema (deploy credentials, shared config) plus every
 * service schema feed the stack's `Config` (root wins on duplicate keys); root items never reach
 * an app, and each service is delivered on its own by name.
 *
 * @example
 * ```ts
 * import * as Alchemy from "alchemy";
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Varlock from "@varlock/alchemy-integration";
 * import * as VarlockCloudflare from "@varlock/alchemy-integration/cloudflare";
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
 *     env: { ...(yield* VarlockCloudflare.bindings(env)), DB: db },
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
 * env: { ...(yield* VarlockCloudflare.bindings(env, "server")), DB: db }
 * ```
 */
export function Secrets<Schemas extends Record<string, object>>(
  options: VarlockServicesOptions<keyof Schemas & string>,
): VarlockServicesProvider<Schemas>;
export function Secrets<Schema extends object = Record<string, unknown>>(
  options?: VarlockSecretsOptions,
): VarlockSecretsProvider<Schema>;
export function Secrets(options: VarlockSecretsOptions | VarlockServicesOptions<string> = {}) {
  return 'services' in options ? multiSchema(options) : singleSchema(options);
}
