import { describe, expect, test } from 'vitest';
import outdent from 'outdent';

import { resolveFieldTypes, generatePythonTypesSrc } from '../../index';
import { loadFixtureFields, loadGraph } from './helpers';

describe('generatePythonTypesSrc', () => {
  test('emits a typed TypedDict, SENSITIVE_KEYS, and a loader', async () => {
    const { fields } = await loadFixtureFields();
    const src = generatePythonTypesSrc(fields);

    expect(src).toContain('class CoercedEnvSchema(TypedDict):');
    // reference-only Public/raw-string types were dropped in favor of SENSITIVE_KEYS + the loader
    expect(src).not.toContain('PublicCoercedEnvSchema');
    expect(src).not.toContain('EnvSchemaAsStrings');

    expect(src).toContain('DB_HOST: str');
    expect(src).toContain('DB_PORT: NotRequired[int]');
    expect(src).toContain('DEBUG: NotRequired[bool]');
    expect(src).toContain('APP_ENV: Literal["dev", "staging", "prod"]');
    expect(src).toContain('CONFIG: NotRequired[dict[str, Any]]');

    // sensitivity is exposed as a constant, not a separate type
    expect(src).toContain('SENSITIVE_KEYS: frozenset[str] = frozenset({"API_KEY"})');

    // ready-to-use loader + eager ENV
    expect(src).toContain('def load_env() -> CoercedEnvSchema:');
    expect(src).toContain('os.environ["__VARLOCK_ENV"]');
    expect(src).toContain('ENV: CoercedEnvSchema = load_env()');
  });

  test('descriptions become comments (no fragile docstrings to escape)', async () => {
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

    // rendered as a `#` comment — a triple-quote in the text can't break the file
    expect(src).toContain('QUOTED: str  # value with """ quotes inside');
  });
});
