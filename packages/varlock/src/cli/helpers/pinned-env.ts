import {
  findPinnedGraphForResolution, getPinnedBootKeys, type PinnedGraphInfo, USE_INJECTED_ENV_VAR,
} from '../../lib/injected-env-reuse';
import type { CliItemFilter } from './item-filter';
import { PreResolvedEnvError, USE_FROZEN_ENV_VAR } from '../../lib/frozen-env-file';
import { CliExitError } from './exit-error';

/**
 * A pre-resolved env (frozen env file, or a blob under `_VARLOCK_USE_INJECTED_ENV=1`) that is
 * requested but unusable, as a CliExitError carrying the error's own suggestion. Neither ever
 * falls back to fresh resolution.
 */
export function pinErrorToCliExitError(err: unknown): CliExitError {
  const message = (err as Error).message.replace(/^\[varlock\] /, '');
  return new CliExitError(message, {
    suggestion: err instanceof PreResolvedEnvError
      ? err.suggestion
      : `Provide a valid __VARLOCK_ENV payload, or unset ${USE_INJECTED_ENV_VAR} to resolve from .env files.`,
  });
}

/** CLI wrapper around findPinnedGraphForResolution, with an unusable pin as a CliExitError */
export function getPinnedGraphForResolution(): PinnedGraphInfo | undefined {
  try {
    return findPinnedGraphForResolution({ env: process.env, cwd: process.cwd() });
  } catch (err) {
    throw pinErrorToCliExitError(err);
  }
}

/**
 * Apply `--frozen` (see FROZEN_ARG) by setting `_VARLOCK_USE_FROZEN_ENV`, so the flag behaves
 * exactly like the env var everywhere downstream: the pin lookup, the child env, and any
 * nested varlock process.
 */
export function applyFrozenArg(value: string | undefined) {
  if (value === undefined) return;
  process.env[USE_FROZEN_ENV_VAR] = value || '1';
}

/**
 * A pin is final: its keys plus its `@dynamic=boot` keys are the whole env. Any scoping (e.g.
 * package.json `varlock.filter`) was applied when it was frozen, so it is not applied again,
 * and other schema items are never resolved at boot (their resolvers may need credentials the
 * runtime does not have). Shaped like a CLI item filter so `load` and `run` apply it the same way.
 */
export function getPinnedItemFilter(pinned: PinnedGraphInfo): CliItemFilter {
  const keys = new Set([...Object.keys(pinned.graph.config), ...getPinnedBootKeys(pinned.graph)]);
  return {
    async resolveScoped(graph) {
      const scoped = [...keys].filter((k) => graph.configSchema[k]);
      await graph.resolveEnvValues([...graph.expandKeysWithTransitiveDeps(scoped)]);
    },
    async computeKeys(graph) {
      return new Set(Object.keys(graph.configSchema).filter((k) => keys.has(k)));
    },
    getFilterKeys(items) {
      return new Set(items.map((item) => item.key).filter((k) => keys.has(k)));
    },
  };
}
