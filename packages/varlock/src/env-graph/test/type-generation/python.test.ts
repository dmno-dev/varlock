import { describe, expect, test } from 'vitest';
import outdent from 'outdent';

import { resolveFieldTypes, generatePythonTypesSrc } from '../../index';
import { getPublicSection, loadFixtureFields, loadGraph } from './helpers';

describe('generatePythonTypesSrc', () => {
  test('maps non-string coerced and raw string types', async () => {
    const { fields } = await loadFixtureFields();
    const src = generatePythonTypesSrc(fields);

    expect(src).toContain('class CoercedEnvSchema(TypedDict):');
    expect(src).toContain('class PublicCoercedEnvSchema(TypedDict):');
    expect(src).toContain('class EnvSchemaAsStrings(TypedDict):');

    expect(src).toContain('DB_HOST: str');
    expect(src).toContain('DB_PORT: NotRequired[int]');
    expect(src).toContain('DEBUG: NotRequired[bool]');
    expect(src).toContain('APP_ENV: Literal["dev"] | Literal["staging"] | Literal["prod"]');
    expect(src).toContain('CONFIG: NotRequired[dict[str, object]]');

    expect(src).toContain('DEBUG: NotRequired[Literal["true", "false"]]');
    expect(src).toContain('DB_PORT: NotRequired[str]');
    expect(src).toContain('APP_ENV: Literal["dev"] | Literal["staging"] | Literal["prod"]');

    const publicSection = getPublicSection(src, 'PublicCoercedEnvSchema', 'EnvSchemaAsStrings');
    expect(publicSection).toContain('DB_PORT: NotRequired[int]');
    expect(publicSection).not.toContain('API_KEY');
  });

  test('description containing triple quotes is escaped safely', async () => {
    const g = await loadGraph({
      envFile: outdent`
        # @defaultSensitive=false
        # ---
        # value with """ quotes inside
        QUOTED=val   # @public @required
      `,
    });

    const items = [await g.configSchema.QUOTED.getTypeGenInfo()];
    const src = generatePythonTypesSrc(resolveFieldTypes(items));

    expect(src).toContain('QUOTED: str');
    expect(src).toContain('\\"\\"\\"');
    expect(src).not.toMatch(/value with """ quotes/);
  });
});
