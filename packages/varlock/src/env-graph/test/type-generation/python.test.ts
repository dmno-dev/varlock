import { describe, expect, test } from 'vitest';
import outdent from 'outdent';

import { resolveFieldTypes, generatePythonEnvSrc } from '../../index';
import { loadFixtureFields, loadGraph } from './helpers';

describe('generatePythonEnvSrc', () => {
  test('emits a typed TypedDict, SENSITIVE_KEYS, and a loader', async () => {
    const { fields } = await loadFixtureFields();
    const src = generatePythonEnvSrc(fields);

    // named `Env` to match the Rust/Go/PHP modules (the "coerced, not strings" note lives in the docstring)
    expect(src).toContain('class Env(TypedDict):');
    expect(src).not.toContain('CoercedEnvSchema');
    expect(src).not.toContain('EnvSchemaAsStrings');

    expect(src).toContain('DB_HOST: str');
    expect(src).toContain('DB_PORT: NotRequired[int]');
    expect(src).toContain('DEBUG: NotRequired[bool]');
    expect(src).toContain('APP_ENV: Literal["dev", "staging", "prod"]');
    expect(src).toContain('CONFIG: NotRequired[dict[str, Any]]');

    // sensitivity is exposed as a constant, not a separate type
    expect(src).toContain('SENSITIVE_KEYS: frozenset[str] = frozenset({"API_KEY"})');

    // ready-to-use loader; no eager module-level ENV (import stays side-effect-free)
    expect(src).toContain('def load_env() -> Env:');
    expect(src).toContain('os.environ.get("__VARLOCK_ENV")');
    expect(src).not.toContain('= load_env()');
    // unset optional keys are skipped (NotRequired = key absent, not present-as-None)
    expect(src).toContain('if "value" in entry');
    // typed via cast(), not a bracketed `# type: ignore[...]` (which pyright ignores)
    expect(src).toContain('return cast(');
    expect(src).not.toContain('type: ignore');
    // clear errors instead of a raw KeyError / JSON error
    expect(src).toContain('__VARLOCK_ENV is not set');
    expect(src).toContain('is encrypted');
  });

  test('skips keys that are not valid identifiers (still tracked as sensitive)', async () => {
    const g = await loadGraph({
      envFile: outdent`
        # @defaultSensitive=false
        # ---
        OK_KEY=a       # @public @required
        MY-KEY=secret  # @sensitive @required
      `,
    });
    const items = [
      await g.configSchema.OK_KEY.getTypeGenInfo(),
      await g.configSchema['MY-KEY'].getTypeGenInfo(),
    ];
    const src = generatePythonEnvSrc(resolveFieldTypes(items));
    expect(src).toContain('OK_KEY: str');
    // omitted from the TypedDict, but still in SENSITIVE_KEYS (redaction can't miss it)
    expect(src).not.toContain('MY-KEY:');
    expect(src).toContain('Keys omitted from this typed module (not valid identifiers): MY-KEY');
    expect(src).toContain('frozenset({"MY-KEY"})');
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
    const src = generatePythonEnvSrc(resolveFieldTypes(items));

    // rendered as a `#` comment — a triple-quote in the text can't break the file
    expect(src).toContain('QUOTED: str  # value with """ quotes inside');
  });
});
