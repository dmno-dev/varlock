import {
  describe, it, expect, vi,
} from 'vitest';
import { checkForSchemaErrors } from '../error-checks';
import outdent from 'outdent';
import { ResolutionError, SchemaError } from '../../../env-graph/lib/errors';
import { EnvGraph } from '../../../env-graph';
import { DotEnvFileDataSource } from '../../../env-graph/lib/data-source';

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

  it('prints a resolution error once when source.errors also includes it', () => {
    // the real DataSource.errors getter includes resolutionErrors
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => { /* swallow */ });
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => { /* swallow */ });
    const resErr = new ResolutionError('Invalid cacheTtl');
    const graph = makeGraphWithSource([resErr], [resErr]);
    expect(() => checkForSchemaErrors(graph)).toThrow();
    const allOutput = consoleError.mock.calls.flat().join('\n');
    expect(allOutput.match(/Invalid cacheTtl/g)).toHaveLength(1);
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

describe('checkForSchemaErrors prints each error once', () => {
  async function loadGraph(schema: string) {
    const g = new EnvGraph();
    await g.setRootDataSource(new DotEnvFileDataSource('.env.schema', { overrideContents: schema }));
    await g.finishLoad();
    return g;
  }

  function captureOutput(fn: () => void) {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => { /* swallow */ });
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => { /* swallow */ });
    try {
      fn();
      return [...consoleError.mock.calls, ...consoleLog.mock.calls].flat().join('\n');
    } finally {
      consoleError.mockRestore();
      consoleLog.mockRestore();
    }
  }

  function countOccurrences(haystack: string, needle: string) {
    return haystack.split(needle).length - 1;
  }

  it('prints a root decorator execute() error once, under the initialization heading', async () => {
    // regression for #1150: `source.errors` also contains `source.resolutionErrors`
    const g = await loadGraph(outdent`
      # @setValuesBulk("{not json", format=json)
      # ---
      FOO=
    `);
    const output = captureOutput(() => checkForSchemaErrors(g, { noThrow: true }));
    expect(countOccurrences(output, 'invalid JSON data')).toBe(1);
    expect(output).toContain('initialization');
  });

  it('prints every error and warning from a real graph exactly once', async () => {
    const g = await loadGraph(outdent`
      # @bogusDec=1
      # @cache=bogus
      # ---
      _VARLOCK_THING=1
    `);
    const errs = g.sortedDataSources.flatMap((s) => [...s.errors, ...s.resolutionErrors]);
    expect(errs.length).toBeGreaterThan(0);
    const output = captureOutput(() => checkForSchemaErrors(g, { noThrow: true }));
    for (const err of new Set(errs)) {
      expect(countOccurrences(output, err.message), err.message).toBe(1);
    }
  });
});
