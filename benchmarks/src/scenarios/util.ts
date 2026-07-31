import { join } from 'node:path';
import { copyFixture } from '../measure.ts';
import type { BenchContext, CliInvocation } from '../types.ts';

/**
 * Workload sizes for the request-latency benches.
 *
 * Both preventLeaks and redactLogs cost scales with how much data they inspect,
 * while the request itself costs a fixed fraction of a millisecond. At 16KB of
 * body / 200 log lines the on-vs-off delta sat entirely inside run-to-run noise,
 * so the scenarios could not answer the question they exist to answer. These
 * sizes put the scanning work above the noise floor.
 */
export const LEAK_SCAN_BODY_BYTES = 2 * 1024 * 1024;
export const REDACT_LOG_LINES = 2_000;

/**
 * Scenario ids must be unique within a run — the same scenario is measured once
 * per install method, and anything reading the committed JSON keys off the id.
 */
export function cliScenarioId(base: string, cli: CliInvocation): string {
  return `${base}.install.${cli.label}`;
}

/**
 * Copy a fixture into the work dir. Scenarios run against the copy so codegen
 * output, caches and build artifacts never land in the checked-in fixtures.
 */
export function fixtureWorkDir(ctx: BenchContext, fixture: string, suffix = ''): string {
  const dest = join(ctx.workDir, 'fixtures', `${fixture}${suffix}`);
  copyFixture(join(ctx.fixturesDir, fixture), dest);
  return dest;
}
