import { CliExitError } from './exit-error';
import {
  PROXY_CHILD_ENV_VAR,
} from '../../proxy/env-vars';

export {
  PROXY_CHILD_ENV_VAR,
};

const COMMANDS_DENIED_IN_PROXY = new Set(['reveal']);

export function isProxyChildProcess(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[PROXY_CHILD_ENV_VAR] === '1';
}

export async function enforceProxyContextGuards(rawArgs: Array<string>, env: NodeJS.ProcessEnv = process.env) {
  if (!isProxyChildProcess(env)) return;

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
