import type { TelemetryMode } from './types.ts';

export type { TelemetryMode };

/** Env overlay for telemetry on/off. Pass through measureCommand. */
export function telemetryEnv(mode: TelemetryMode): Record<string, string | undefined> {
  if (mode === 'off') {
    return {
      VARLOCK_TELEMETRY_DISABLED: '1',
      // Clear legacy opt-out so "off" is unambiguous
      PH_OPT_OUT: undefined,
    };
  }
  // Explicitly clear disable flags so a parent-shell opt-out does not leak in
  return {
    VARLOCK_TELEMETRY_DISABLED: undefined,
    PH_OPT_OUT: undefined,
  };
}

export const TELEMETRY_MODES: Array<TelemetryMode> = ['off', 'on'];
