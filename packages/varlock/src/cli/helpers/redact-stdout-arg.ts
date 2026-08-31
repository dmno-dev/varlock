/**
 * Shared gunshi arg spec for the redaction override, so `varlock run` and
 * `varlock proxy run` expose an identical flag (including `--no-redact-stdout`,
 * which only works because of `negatable`).
 *
 * Kept in its own module so the command spec files can pull it in without
 * dragging the redaction implementation (and everything it imports) into the
 * CLI entry point's static import graph.
 */
export const REDACT_STDOUT_ARG = {
  'redact-stdout': {
    type: 'boolean',
    negatable: true,
    description: 'Override automatic stdout/stderr redaction: --redact-stdout forces redaction of piped/redirected output (e.g., to override @redactLogs=false) and errors if attached to an interactive terminal; --no-redact-stdout disables redaction entirely. Can also be set via the _VARLOCK_REDACT_STDOUT env var (the flag takes precedence)',
  },
} as const;
