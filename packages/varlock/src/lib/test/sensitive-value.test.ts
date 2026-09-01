import { describe, expect, test } from 'vitest';
import outdent from 'outdent';
import { DotEnvFileDataSource, EnvGraph } from '../../env-graph';
import { getItemSummary } from '../formatting';
import { collectLeaves, redactSensitiveDisplayValue } from '../sensitive-value';

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

describe('collectLeaves', () => {
  test('splits leaves by whether redaction can match them', () => {
    expect(collectLeaves('acmeco')).toEqual({ redactable: ['acmeco'], unredactable: [] });
    // redaction only ever replaces strings, so a number is never in the map
    expect(collectLeaves(987654)).toEqual({ redactable: [], unredactable: ['987654'] });
    expect(collectLeaves('')).toEqual({ redactable: [], unredactable: [] });
    expect(collectLeaves(undefined)).toEqual({ redactable: [], unredactable: [] });
  });

  // each element of a composite registers on its own, so a long joined form says nothing
  // about whether one of its elements will collide with ordinary text
  test('walks composites per element', () => {
    expect(collectLeaves(['averylongsecretvalue', 'x']).redactable).toEqual(['averylongsecretvalue', 'x']);
    expect(collectLeaves({ a: 'averylongsecretvalue', b: 2 })).toEqual({
      redactable: ['averylongsecretvalue'],
      unredactable: ['2'],
    });
  });
});

describe('getItemSummary redaction', () => {
  test('a sensitive value is masked whether or not it coerced to a string', async () => {
    const g = new EnvGraph();
    await g.setRootDataSource(new DotEnvFileDataSource('.env.schema', {
      overrideContents: outdent`
        # @defaultRequired=false
        # ---
        # sensitive by default rather than by decorator, since an explicit @sensitive on a
        # number is rejected - but it is still sensitive, so it must still be masked
        NUMERIC_SECRET=98765432109876

        # @sensitive
        STRING_SECRET="98765432109876"

        # @sensitive=false
        PUBLIC_PORT=8080
      `,
    }));
    await g.finishLoad();
    await g.resolveEnvValues();

    expect(g.configSchema.NUMERIC_SECRET.isSensitive).toBe(true);
    expect(getItemSummary(g.configSchema.NUMERIC_SECRET)).not.toContain('98765432109876');
    expect(getItemSummary(g.configSchema.STRING_SECRET)).not.toContain('98765432109876');
    // a non-sensitive value is still shown in full
    expect(getItemSummary(g.configSchema.PUBLIC_PORT)).toContain('8080');
  });

  // the "< coerced from ..." suffix prints the same secret in its pre-coercion form,
  // so masking only the coerced value still leaks it
  test('the pre-coercion raw value is masked too', async () => {
    const g = new EnvGraph();
    await g.setRootDataSource(new DotEnvFileDataSource('.env.schema', {
      overrideContents: outdent`
        # @defaultRequired=false
        # ---
        # @sensitive @type=array(string)
        LIST_SECRET=aaaaaaaaaaaaaaaaaaaa,bbbbbbbbbbbbbbbbbb
      `,
    }));
    await g.finishLoad();
    await g.resolveEnvValues();

    const item = g.configSchema.LIST_SECRET;
    expect(item.isCoerced).toBe(true);
    const summary = getItemSummary(item);
    expect(summary).toContain('coerced from');
    expect(summary).not.toContain('aaaaaaaaaaaaaaaaaaaa');
    expect(summary).not.toContain('bbbbbbbbbbbbbbbbbb');
  });
});
