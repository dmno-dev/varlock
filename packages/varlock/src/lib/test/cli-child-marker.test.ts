import {
  describe, it, expect, afterEach,
} from 'vitest';
import { isVarlockCliChild, CLI_CHILD_MARKER } from '../cli-child-marker';
import { clearCliChildMarker } from '../../cli/helpers/clear-cli-child-marker';

describe('cli child marker', () => {
  afterEach(() => {
    delete process.env[CLI_CHILD_MARKER];
    delete (globalThis as any).__varlockEnvState;
  });

  it('detects the marker', () => {
    expect(isVarlockCliChild({})).toBe(false);
    expect(isVarlockCliChild({ [CLI_CHILD_MARKER]: '1' })).toBe(true);
    process.env[CLI_CHILD_MARKER] = '1';
    expect(isVarlockCliChild()).toBe(true);
  });

  it('clearCliChildMarker scrubs process.env and the runtime pre-injection snapshot', () => {
    process.env[CLI_CHILD_MARKER] = '1';
    (globalThis as any).__varlockEnvState = { originalProcessEnv: { [CLI_CHILD_MARKER]: '1', OTHER: 'x' } };

    clearCliChildMarker();

    expect(process.env[CLI_CHILD_MARKER]).toBeUndefined();
    expect((globalThis as any).__varlockEnvState.originalProcessEnv).toEqual({ OTHER: 'x' });
  });
});
