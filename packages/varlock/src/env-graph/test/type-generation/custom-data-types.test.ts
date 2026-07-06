import { describe, expect, test } from 'vitest';
import outdent from 'outdent';

import { generateGoEnvSrc, generateTsTypesSrc } from '../../index';
import { createEnvGraphDataType } from '../../lib/data-types';
import { loadFixtureFields } from './helpers';

// mimics what a plugin registers via registerDataType — a type whose coerce() outputs
// a non-string value, declared via `coercedType`
const RetryCountDataType = createEnvGraphDataType({
  name: 'retry-count',
  coercedType: 'int',
  coerce: (val) => parseInt(String(val), 10),
});

// no coercedType declared — coerces to string by default
const CustomTokenDataType = createEnvGraphDataType({
  name: 'custom-token',
});

const CUSTOM_TYPE_FIXTURE = outdent`
  # @defaultSensitive=false
  # ---
  # @type=retry-count
  RETRIES=3        # @required @public
  # @type=custom-token
  TOKEN=abc        # @required @public
`;

describe('plugin-registered data types', () => {
  test('coercedType declared on the type def drives generated field types', async () => {
    const { fields } = await loadFixtureFields(CUSTOM_TYPE_FIXTURE, {
      dataTypes: [RetryCountDataType, CustomTokenDataType],
    });
    const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));
    expect(byKey.RETRIES.coerced).toBe('int');
    // a type that declares no coercedType stays a string
    expect(byKey.TOKEN.coerced).toBe('string');

    // the generated Go loader json.Unmarshals the coerced blob value — a numeric value
    // into a string field fails at runtime, so the field must be numeric
    const goSrc = generateGoEnvSrc(fields);
    expect(goSrc).toMatch(/Retries +int64/);
    expect(goSrc).toMatch(/Token +string/);

    const tsSrc = await generateTsTypesSrc(fields);
    expect(tsSrc).toContain('RETRIES: number;');
    expect(tsSrc).toContain('TOKEN: string;');
  });
});
