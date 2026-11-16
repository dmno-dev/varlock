import * as Config from 'effect/Config';
import * as Effect from 'effect/Effect';
import * as Redacted from 'effect/Redacted';
import type { SerializedEnvGraph } from 'varlock';
import { buildEnvBlobBindings } from 'varlock/env-blob';
import {
  appGraphFor, configError, envString,
  type BindingsServices, type VarlockSecretsProvider, type VarlockServicesProvider,
} from './core';

/** Cloudflare Workers cap each secret at 5KB; the blob chunk size */
const CLOUDFLARE_SECRET_MAX_BYTES = 5120;

/**
 * Variables alchemy binds into every Worker itself (and skips on deploy when `env` repeats
 * them). Schema items with these names stay in the `__VARLOCK_ENV` blob but are not bound again.
 */
const WORKER_RUNTIME_KEYS = new Set(['ALCHEMY_PHASE', 'ALCHEMY_WORKER_NAME', 'ALCHEMY_STACK_NAME', 'ALCHEMY_STAGE', 'ALCHEMY_CLOUDFLARE_ACCOUNT_ID']);

export interface WorkerBindingsOptions {
  /**
   * Include the `__VARLOCK_ENV` runtime blob so `@varlock/cloudflare-integration/init` can boot
   * varlock inside the Worker (log redaction, leak detection, typed `ENV`). Default `true`; a
   * blob over Cloudflare's 5KB secret limit is split into chunks.
   */
  blob?: boolean;
}

/** Bindings that carry the varlock runtime blob (all uploaded as secrets except the chunk count). */
export type VarlockRuntimeBindings = {
  readonly __VARLOCK_ENV?: Config.Config<Redacted.Redacted<string>>;
  readonly __VARLOCK_ENV_CHUNKS?: Config.Config<string>;
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
export type WorkerBindingValue<T> = T extends string | number | boolean ? T : string;

/**
 * Worker bindings for a schema, keyed like the schema. Types come from varlock's generated
 * types (`CoercedEnvSchema` in the schema's `env.d.ts`): pass that type to `Varlock.Secrets`.
 * Sensitive items are `Redacted` at deploy time and `secret_text` on the Worker; at runtime the
 * Worker sees plain values, which is what `Cloudflare.InferEnv` reports.
 *
 * Optional schema items stay optional: an item that resolves to no value is not bound. Types
 * cannot see `bindingsFilter`, so leave the keys it removes out of `Schema` yourself
 * (`Omit<CoercedEnvSchema, 'CLOUDFLARE_API_TOKEN'>`), or the Worker's `Env` will list them.
 */
export type WorkerBindings<Schema extends object> = {
  readonly [K in keyof Schema]: Config.Config<WorkerBindingValue<NonNullable<Schema[K]>>>;
} & VarlockRuntimeBindings;

function encryptInjectedEnvError(): Config.ConfigError {
  return configError([
    'varlock: @encryptInjectedEnv is on, but a Cloudflare Worker receives the __VARLOCK_ENV blob as a secret binding,',
    'with the key as another secret beside it, so encryption would protect nothing and change the blob on every deploy.',
    'Turn it off for alchemy runs and keep it for other builds:  # @encryptInjectedEnv=isEmpty($ALCHEMY_STAGE)',
    '(declare ALCHEMY_STAGE in the schema), or pass { blob: false } if the Worker does not use the varlock runtime.',
  ].join('\n'));
}

function workerBindings(
  graph: SerializedEnvGraph,
  opts: WorkerBindingsOptions,
): Effect.Effect<Record<string, Config.Config<unknown>>, Config.ConfigError> {
  const bindings: Record<string, Config.Config<unknown>> = {};
  for (const [key, item] of Object.entries(graph.config)) {
    if (item.value === undefined || WORKER_RUNTIME_KEYS.has(key)) continue;
    // values are literal Configs, so they never consult the provider
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
  if (opts.blob === false) return Effect.succeed(bindings);
  if (graph.settings?.encryptInjectedEnv) return Effect.fail(encryptInjectedEnvError());
  // plaintext also ignores an ambient _VARLOCK_ENV_KEY, for the same reason as the error above
  const blob = buildEnvBlobBindings({
    json: JSON.stringify(graph),
    plaintext: true,
    maxBytes: CLOUDFLARE_SECRET_MAX_BYTES,
  });
  for (const [key, value] of Object.entries(blob)) {
    bindings[key] = key === '__VARLOCK_ENV_CHUNKS'
      ? Config.succeed(value)
      : Config.succeed(Redacted.make(value));
  }
  return Effect.succeed(bindings);
}

/**
 * Cloudflare Worker bindings for a varlock schema, to spread into a Worker's `env`. Each item
 * becomes its own binding (`secret_text` for `@sensitive`, plain text or JSON otherwise), plus
 * the `__VARLOCK_ENV` blob for `@varlock/cloudflare-integration/init` unless `blob: false`.
 *
 * @example
 * ```ts
 * env: { ...(yield* VarlockCloudflare.bindings(env)), DB: db }
 * env: { ...(yield* VarlockCloudflare.bindings(env, "server", { blob: false })) }
 * ```
 */
export function bindings<Schema extends object>(
  provider: VarlockSecretsProvider<Schema>,
  options?: WorkerBindingsOptions,
): Effect.Effect<WorkerBindings<Schema>, Config.ConfigError, BindingsServices>;
export function bindings<Schemas extends Record<string, object>, Name extends keyof Schemas & string>(
  provider: VarlockServicesProvider<Schemas>,
  service: Name,
  options?: WorkerBindingsOptions,
): Effect.Effect<WorkerBindings<Schemas[Name]>, Config.ConfigError, BindingsServices>;
export function bindings(
  provider: VarlockSecretsProvider<object> | VarlockServicesProvider<Record<string, object>>,
  serviceOrOptions?: string | WorkerBindingsOptions,
  maybeOptions?: WorkerBindingsOptions,
): Effect.Effect<Record<string, Config.Config<unknown>>, Config.ConfigError, BindingsServices> {
  const service = typeof serviceOrOptions === 'string' ? serviceOrOptions : '';
  const options = (typeof serviceOrOptions === 'string' ? maybeOptions : serviceOrOptions) ?? {};
  return appGraphFor(provider, service).pipe(Effect.flatMap((graph) => workerBindings(graph, options)));
}
