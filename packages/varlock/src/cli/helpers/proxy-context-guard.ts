import { CliExitError } from './exit-error';
import { loadVarlockEnvGraph } from '../../lib/load-graph';
import { buildProxySchemaFingerprint } from './proxy-schema-fingerprint';

export const PROXY_CHILD_ENV_VAR = '__VARLOCK_PROXY_CHILD';
export const PROXY_SCHEMA_FINGERPRINT_ENV_VAR = '__VARLOCK_PROXY_SCHEMA_FINGERPRINT';

const COMMANDS_DENIED_IN_PROXY = new Set(['run', 'printenv', 'reveal']);

export function isProxyChildProcess(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[PROXY_CHILD_ENV_VAR] === '1';
}

/**
 * Parse a subset of load flags needed for proxied-context policy checks.
 * We only care about format + agent safety flags.
 */
export function parseLoadSafetyArgs(argsAfterCommand: Array<string>): {
  format: 'pretty' | 'json' | 'env' | 'shell' | 'json-full';
  agent: boolean;
  env?: string;
  paths?: Array<string>;
} {
  let format: 'pretty' | 'json' | 'env' | 'shell' | 'json-full' = 'pretty';
  let agent = false;
  let currentEnvFallback: string | undefined;
  const paths: Array<string> = [];

  for (let i = 0; i < argsAfterCommand.length; i++) {
    const arg = argsAfterCommand[i];

    if (arg === '--') break;

    if (arg === '--agent') {
      agent = true;
      continue;
    }

    if (arg === '--env') {
      const next = argsAfterCommand[i + 1];
      if (next && !next.startsWith('-')) {
        currentEnvFallback = next;
      }
      continue;
    }

    if (arg.startsWith('--env=')) {
      currentEnvFallback = arg.slice('--env='.length);
      continue;
    }

    if (arg === '--path' || arg === '-p') {
      const next = argsAfterCommand[i + 1];
      if (next && !next.startsWith('-')) {
        paths.push(next);
      }
      continue;
    }

    if (arg.startsWith('--path=')) {
      paths.push(arg.slice('--path='.length));
      continue;
    }

    if (arg.startsWith('-p=')) {
      paths.push(arg.slice(3));
      continue;
    }

    if (arg === '--format' || arg === '-f') {
      const next = argsAfterCommand[i + 1];
      if (next && !next.startsWith('-')) {
        const parsed = next as typeof format;
        if (parsed === 'pretty' || parsed === 'json' || parsed === 'env' || parsed === 'shell' || parsed === 'json-full') {
          format = parsed;
        }
      }
      continue;
    }

    if (arg.startsWith('--format=')) {
      const inline = arg.slice('--format='.length) as typeof format;
      if (inline === 'pretty' || inline === 'json' || inline === 'env' || inline === 'shell' || inline === 'json-full') {
        format = inline;
      }
      continue;
    }

    if (arg.startsWith('-f=')) {
      const inline = arg.slice(3) as typeof format;
      if (inline === 'pretty' || inline === 'json' || inline === 'env' || inline === 'shell' || inline === 'json-full') {
        format = inline;
      }
    }
  }

  return {
    format,
    agent,
    ...(currentEnvFallback ? { env: currentEnvFallback } : {}),
    ...(paths.length ? { paths } : {}),
  };
}

async function assertLoadAllowedInProxy(argsAfterCommand: Array<string>, env: NodeJS.ProcessEnv) {
  const {
    format, agent, env: currentEnvFallback, paths,
  } = parseLoadSafetyArgs(argsAfterCommand);

  if (format === 'pretty' || format === 'json' || format === 'json-full') {
    const expectedFingerprint = env[PROXY_SCHEMA_FINGERPRINT_ENV_VAR];
    if (expectedFingerprint) {
      let currentFingerprint: string;
      try {
        const graph = await loadVarlockEnvGraph({
          ...(currentEnvFallback ? { currentEnvFallback } : {}),
          ...(paths ? { entryFilePaths: paths } : {}),
        });
        currentFingerprint = buildProxySchemaFingerprint(graph);
      } catch {
        throw new CliExitError(
          'Command blocked in proxied context: schema could not be verified against approved proxy snapshot.',
          {
            suggestion: 'Restart `varlock run --proxy` after reviewing schema changes in a trusted context.',
          },
        );
      }

      if (currentFingerprint !== expectedFingerprint) {
        throw new CliExitError(
          'Command blocked in proxied context: schema changed since proxy start and is awaiting trusted approval.',
          {
            suggestion: 'Restart `varlock run --proxy` after reviewing and approving schema changes.',
          },
        );
      }
    }
  }

  // pretty stays allowed (default, redacted summaries)
  if (format === 'pretty') return;

  // json/json-full can be allowed in explicit agent-safe mode
  if ((format === 'json' || format === 'json-full') && agent) return;

  throw new CliExitError(
    `Command blocked in proxied context: \`varlock load\` with format \`${format}\` can expose raw values.`,
    {
      suggestion: 'Use `varlock load` (pretty) or `varlock load --agent --format json` instead.',
    },
  );
}

export async function enforceProxyContextGuards(rawArgs: Array<string>, env: NodeJS.ProcessEnv = process.env) {
  if (!isProxyChildProcess(env)) return;

  const command = rawArgs[0];
  if (!command || command.startsWith('-')) return;

  if (COMMANDS_DENIED_IN_PROXY.has(command)) {
    throw new CliExitError(
      `Command blocked in proxied context: \`varlock ${command}\` is disabled to prevent secret recovery.`,
      {
        suggestion: 'Run this command outside `varlock run --proxy`, or request explicit user approval in a trusted context.',
      },
    );
  }

  if (command === 'load') {
    await assertLoadAllowedInProxy(rawArgs.slice(1), env);
  }
}
