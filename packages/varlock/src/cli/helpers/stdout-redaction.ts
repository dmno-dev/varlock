import { CliExitError } from './exit-error';
import { createRedactedStreamWriter, PARENT_REDACTED_STREAMS_ENV_VAR } from '../../runtime/lib/redact-stream';
import { parseEnvToggle } from '../../runtime/lib/env-toggle';

export { REDACT_STDOUT_ARG } from './redact-stdout-arg';
export { parseEnvToggle };

export type StdoutRedactionPlan = { redactStdout: boolean; redactStderr: boolean };

/**
 * Decide, per stream, whether a spawned child's stdout/stderr should be piped through the
 * redactor or inherited raw. Shared by `varlock run` and `varlock proxy run` so the two
 * commands cannot diverge.
 *
 * A stream attached to an interactive terminal is inherited (raw TTY, so interactive tools
 * like `claude`/`psql` work, and a human at the terminal already sees the secrets). Piped or
 * redirected streams (CI logs, files, pagers) are where leaked output persists, so those are
 * routed through the redactor.
 *
 * The `--redact-stdout` / `--no-redact-stdout` flag, then `_VARLOCK_REDACT_STDOUT`, overrides
 * the auto-detect. Forcing redaction onto a TTY is impossible without a PTY, so we throw.
 */
export function resolveStdoutRedaction(opts: {
  redactStdoutFlag: boolean | undefined;
  /** the schema's `@redactLogs` stdout setting (`settings.redactStdout`), on when unset */
  redactStdoutSetting: boolean;
}): StdoutRedactionPlan {
  const redactOverride = opts.redactStdoutFlag ?? parseEnvToggle(process.env._VARLOCK_REDACT_STDOUT);
  const forceRedact = redactOverride === true;
  const forceNoRedact = redactOverride === false;

  // Redacting a TTY-attached stream is impossible without piping it, which breaks
  // interactive/TTY tools (claude, psql) - so fail loudly rather than silently degrade.
  if (forceRedact && (process.stdout.isTTY || process.stderr.isTTY)) {
    throw new CliExitError('Cannot force redaction while output is attached to an interactive terminal', {
      details: [
        'Redaction requires piping stdout/stderr, which breaks tools that need a raw TTY (e.g., claude, psql).',
        'Redaction is applied automatically whenever output is piped or redirected, so you can likely just drop the --redact-stdout flag.',
      ],
    });
  }

  const redactionEnabled = !forceNoRedact && (opts.redactStdoutSetting || forceRedact);
  return {
    redactStdout: redactionEnabled && (forceRedact || !process.stdout.isTTY),
    redactStderr: redactionEnabled && (forceRedact || !process.stderr.isTTY),
  };
}

/**
 * Wire the shared chunk-boundary-buffered redactor onto whichever of the child's streams the
 * plan marks for redaction (so a secret split across two chunks is still caught). No-ops for
 * any stream that is inherited, since there is no pipe to read.
 */
export function pipeRedactedStreams(
  commandProcess: { stdout?: NodeJS.ReadableStream | null; stderr?: NodeJS.ReadableStream | null },
  plan: StdoutRedactionPlan,
): void {
  if (plan.redactStdout && commandProcess.stdout) {
    const writer = createRedactedStreamWriter(process.stdout);
    commandProcess.stdout.on('data', writer.write);
    commandProcess.stdout.on('close', writer.flush);
  }
  if (plan.redactStderr && commandProcess.stderr) {
    const writer = createRedactedStreamWriter(process.stderr);
    commandProcess.stderr.on('data', writer.write);
    commandProcess.stderr.on('close', writer.flush);
  }
}

/**
 * Tell the child which of its streams this process is already redacting, so an in-process
 * stream patch (`varlock/auto-load` with `@redactLogs={stdout=true}`) can skip them instead
 * of redacting (and holding back partial matches) twice. Always rewritten, so a marker
 * inherited from an outer `varlock run` never outlives the pipe it described.
 */
export function setParentRedactedStreamsEnv(env: Record<string, string | undefined>, plan: StdoutRedactionPlan): void {
  const streams = [plan.redactStdout && 'stdout', plan.redactStderr && 'stderr'].filter(Boolean);
  if (streams.length) env[PARENT_REDACTED_STREAMS_ENV_VAR] = streams.join(',');
  else delete env[PARENT_REDACTED_STREAMS_ENV_VAR];
}
