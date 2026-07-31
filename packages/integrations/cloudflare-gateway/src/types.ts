import type { ProxyActivity, ProxyEgressMode, ProxyRule } from 'varlock/proxy-core';

/** Structural subset of Cloudflare's ExecutionContext (avoids a workers-types dependency). */
export type WaitUntilContext = { waitUntil?: (promise: Promise<unknown>) => void };

export type VarlockGatewayConfig = {
  /** Proxy routing rules (same shape the local proxy enforces, compiled from `@proxy(...)` decorators). */
  rules: Array<ProxyRule>;
  /**
   * `strict` (default): only requests matching a `@proxy` rule are forwarded.
   * A hosted gateway should not be an open forwarder, even behind its token, so
   * the default here is stricter than the local proxy's.
   */
  egressMode?: ProxyEgressMode;
  /**
   * Managed item key → the placeholder the workload holds. Real values are NEVER
   * part of this config: they are fetched per request via `getSecretValue`, so
   * the worker bundle stays secret-free.
   */
  placeholders: Record<string, string>;
  /**
   * Fetch the real value for a managed item, called lazily per request for the
   * items actually in scope. Defaults to reading the worker env binding named
   * after the item key (worker secrets). Async so stores like Secrets Store or a
   * Durable Object can back it without an interface change.
   */
  getSecretValue?: (itemKey: string, env: unknown) => string | undefined | Promise<string | undefined>;
  /**
   * The data-plane token an external workload must present (explicit-gateway
   * mode only). Defaults to reading `env._VARLOCK_GATEWAY_TOKEN`. Return
   * undefined to refuse all external requests (fail closed).
   */
  getToken?: (env: unknown) => string | undefined;
  /**
   * Audit sink for per-request decisions (never contains secret values).
   * Defaults to a structured `console.log`, which lands in Workers Logs.
   */
  onAudit?: (activity: ProxyActivity) => void;
  /**
   * Called after an upstream response is forwarded, with any managed keys whose
   * real value appeared in it and was scrubbed back to a placeholder.
   */
  onResponse?: (info: {
    host: string;
    method: string;
    path: string;
    statusCode: number;
    scrubbedKeys: Array<string>;
    streamed?: boolean;
  }) => void;
};
