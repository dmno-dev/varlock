import {
  describe, it, expect, vi,
} from 'vitest';
import { checkForSchemaErrors } from '../error-checks';
import { ResolutionError, SchemaError } from '../../../env-graph/lib/errors';

/**
 * Minimal stub of EnvGraph that exposes only what checkForSchemaErrors reads.
 * We intentionally avoid spinning up the full graph so we can target the
 * "no schema errors but a fatal resolution error" path directly.
 */
function makeGraphWithSource(errors: Array<any>, resolutionErrors: Array<any>) {
  return {
    sortedDataSources: [
      {
        label: '.env.schema',
        errors,
        resolutionErrors,
      },
    ],
  } as any;
}

describe('checkForSchemaErrors', () => {
  it('throws on schema errors', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => { /* swallow */ });
    const graph = makeGraphWithSource([new SchemaError('bad thing')], []);
    expect(() => checkForSchemaErrors(graph)).toThrow();
    consoleError.mockRestore();
  });

  it('throws on root-decorator resolution errors even when no other schema errors exist', () => {
    // regression: previously the function `continue`d past resolution errors
    // when the source had no other schema/warning, so invalid plugin options
    // like cacheTtl="garbage" silently fell through to resolveEnvValues.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => { /* swallow */ });
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => { /* swallow */ });
    const graph = makeGraphWithSource([], [new ResolutionError('Invalid cacheTtl')]);
    expect(() => checkForSchemaErrors(graph)).toThrow();
    // verify the resolution error was actually printed
    const allOutput = consoleError.mock.calls.flat().join('\n');
    expect(allOutput).toContain('Invalid cacheTtl');
    expect(allOutput).toContain('initialization');
    consoleError.mockRestore();
    consoleLog.mockRestore();
  });

  it('does not throw when source is clean', () => {
    const graph = makeGraphWithSource([], []);
    const result = checkForSchemaErrors(graph);
    expect(result).toEqual({ hasErrors: false, hasOutput: false });
  });

  it('returns without throwing for warnings only (when noThrow is false)', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => { /* swallow */ });
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => { /* swallow */ });
    const warning = new SchemaError('a warning', { isWarning: true });
    const graph = makeGraphWithSource([warning], []);
    const result = checkForSchemaErrors(graph);
    expect(result.hasErrors).toBe(false);
    expect(result.hasOutput).toBe(true);
    consoleError.mockRestore();
    consoleLog.mockRestore();
  });
});
