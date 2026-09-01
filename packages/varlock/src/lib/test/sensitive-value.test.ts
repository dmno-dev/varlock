import { describe, expect, test } from 'vitest';
import outdent from 'outdent';
import { DotEnvFileDataSource, EnvGraph } from '../../env-graph';
import { getItemSummary } from '../formatting';
import { isShortSensitiveValue, redactSensitiveDisplayValue } from '../sensitive-value';

describe('redactSensitiveDisplayValue', () => {
  // redactString only handles strings, so callers that guarded on isString
  // rendered non-string sensitive values in cleartext
  test('redacts non-string values, not just strings', () => {
    expect(redactSensitiveDisplayValue('987654')).not.toContain('987654');
    expect(redactSensitiveDisplayValue(987654)).not.toContain('987654');
    expect(redactSensitiveDisplayValue(true)).not.toContain('true');
  });

  test('leaves nothing to show for empty values', () => {
    expect(redactSensitiveDisplayValue(undefined)).toBeUndefined();
    expect(redactSensitiveDisplayValue('')).toBeUndefined();
  });
});

describe('isShortSensitiveValue', () => {
  test('measures the value as text, whatever its type', () => {
    expect(isShortSensitiveValue('acmeco')).toBe(true);
    expect(isShortSensitiveValue(987654)).toBe(true);
    expect(isShortSensitiveValue('sk-live-9f2b71c4a8de')).toBe(false);
    expect(isShortSensitiveValue('')).toBe(false);
    expect(isShortSensitiveValue(undefined)).toBe(false);
  });
});

describe('getItemSummary redaction', () => {
  test('a sensitive value is masked whether or not it coerced to a string', async () => {
    const g = new EnvGraph();
    await g.setRootDataSource(new DotEnvFileDataSource('.env.schema', {
      overrideContents: outdent`
        # @defaultRequired=false
        # ---
        # a bare numeric value infers as a number - it must still be masked
        # @sensitive
        NUMERIC_SECRET=987654

        # @sensitive
        STRING_SECRET="987654"

        # @sensitive=false
        PUBLIC_PORT=8080
      `,
    }));
    await g.finishLoad();
    await g.resolveEnvValues();

    expect(getItemSummary(g.configSchema.NUMERIC_SECRET)).not.toContain('987654');
    expect(getItemSummary(g.configSchema.STRING_SECRET)).not.toContain('987654');
    // a non-sensitive value is still shown in full
    expect(getItemSummary(g.configSchema.PUBLIC_PORT)).toContain('8080');
  });
});
