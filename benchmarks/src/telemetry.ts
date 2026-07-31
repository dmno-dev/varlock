import type { TelemetryMode } from './types.ts';

export type { TelemetryMode };

/**
 * Env overlay for telemetry on/off. Pass through measureCommand.
 *
 * `mockEnv` points the collector at the local mock (see telemetry-mock.ts) and is
 * required for 'on' — benchmarks never send real telemetry. Callers get it from
 * `ctx.telemetryMockEnv`, which is empty when the mock is unavailable, in which
 * case 'on' has already been dropped from `ctx.telemetryModes`.
 */
export function telemetryEnv(
  mode: TelemetryMode,
  mockEnv: Record<string, string> = {},
): Record<string, string | undefined> {
  if (mode === 'off') {
    return {
      VARLOCK_TELEMETRY_DISABLED: '1',
      // Clear legacy opt-out so "off" is unambiguous
      PH_OPT_OUT: undefined,
    };
  }
  if (!mockEnv.VARLOCK_POSTHOG_HOST) {
    throw new Error('telemetryEnv("on") requires the local telemetry mock — refusing to emit real telemetry');
  }
  // Explicitly clear disable flags so a parent-shell opt-out does not leak in
  return {
    VARLOCK_TELEMETRY_DISABLED: undefined,
    PH_OPT_OUT: undefined,
    ...mockEnv,
  };
}

export const ALL_TELEMETRY_MODES: Array<TelemetryMode> = ['off', 'on'];
