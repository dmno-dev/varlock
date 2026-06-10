import { CliExitError } from './exit-error';
import { createDebug } from '../../lib/debug';
import { resolveActiveProxySession } from '../../proxy/session-registry';
import {
  PROXY_CHILD_ENV_VAR,
} from '../../proxy/env-vars';

export {
  PROXY_CHILD_ENV_VAR,
};

const debug = createDebug('varlock:proxy-guard');

const COMMANDS_DENIED_IN_PROXY = new Set(['reveal']);

export function isProxyChildProcess(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[PROXY_CHILD_ENV_VAR] === '1';
}

/**
 * Whether the current process is running inside a proxy session. The env marker
 * is the fast path; process-ancestry is the authoritative fallback that a child
 * can't defeat by clearing the marker. When the marker is absent but ancestry
 * says we're proxied, that's a likely bypass probe — logged as a signal.
 */
async function isInProxyContext(env: NodeJS.ProcessEnv): Promise<boolean> {
  if (isProxyChildProcess(env)) return true;

  const session = await resolveActiveProxySession(env);
  if (session) {
    debug(
      'proxy context detected via process ancestry with the env marker absent '
        + '(possible bypass attempt) — session %s',
      session.id,
    );
    return true;
  }
  return false;
}

export async function enforceProxyContextGuards(rawArgs: Array<string>, env: NodeJS.ProcessEnv = process.env) {
  if (!(await isInProxyContext(env))) return;

  const command = rawArgs[0];
  if (!command || command.startsWith('-')) return;

  if (command === 'proxy') {
    const action = rawArgs[1];
    if (!action || action.startsWith('-')) return;
    if (action === 'run' || action === 'start') {
      throw new CliExitError(
        `Command blocked in proxied context: \`varlock proxy ${action}\` is disabled to prevent nested proxy execution.`,
        {
          suggestion: 'Use `varlock proxy env`, `varlock proxy status`, or `varlock proxy refresh` from within proxied sessions.',
        },
      );
    }
    return;
  }

  if (COMMANDS_DENIED_IN_PROXY.has(command)) {
    throw new CliExitError(
      `Command blocked in proxied context: \`varlock ${command}\` is disabled to prevent secret recovery.`,
      {
        suggestion: 'Run this command outside `varlock proxy run -- ...`, or request explicit user approval in a trusted context.',
      },
    );
  }
}
