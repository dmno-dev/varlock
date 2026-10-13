import { describe, expect, test } from 'vitest';
import outdent from 'outdent';

import { resolveFieldTypes, generatePythonEnvSrc } from '../../index';
import { COMPOSITE_TYPE_FIXTURE, loadFixtureFields, loadGraph } from './helpers';

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

  test('float and mixed enums fall back to unions (PEP 586 forbids float Literals)', async () => {
    const { fields } = await loadFixtureFields(outdent`
      # @defaultSensitive=false
      # ---
      # @type=enum(0.5, 1.5)
      FLOAT_ENUM=0.5     # @required @public
      # @type=enum(low, 1.5)
      MIXED_ENUM=low     # @required @public
      # @type=enum(one, 2)
      INT_MIX_ENUM=one   # @required @public
    `);
    const src = generatePythonEnvSrc(fields);
    expect(src).toContain('FLOAT_ENUM: float');
    // the runtime value can be the string member — bare `float` would be wrong
    expect(src).toContain('MIXED_ENUM: str | float');
    // mixed without floats can still be narrowed to a Literal
    expect(src).toContain('INT_MIX_ENUM: Literal["one", 2]');
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

  test('docs become attribute docstrings, with quotes and backslashes escaped', async () => {
    const g = await loadGraph({
      envFile: outdent`
        # @defaultSensitive=false
        # ---
        # value with """ quotes and a back\\slash
        # second line
        # @docs("Setup guide", https://example.com/setup)
        # @docs(https://example.com/ref)
        QUOTED=val   # @public @required
        # one-liner
        SHORT=val    # @public @optional
      `,
    });

    const items = [
      await g.configSchema.QUOTED.getTypeGenInfo(),
      await g.configSchema.SHORT.getTypeGenInfo(),
    ];
    const src = generatePythonEnvSrc(resolveFieldTypes(items));

    // every quote is escaped, so the text can't close the docstring early
    const quotedDoc = [
      '"""value with \\"\\"\\" quotes and a back\\\\slash',
      'second line',
      '',
      'Docs: [Setup guide](https://example.com/setup)',
      'Docs: <https://example.com/ref>',
      '"""',
    ];
    expect(src).toContain(['    QUOTED: str', ...quotedDoc.map((l) => (l ? `    ${l}` : ''))].join('\n'));
    expect(src).toContain('    SHORT: NotRequired[str]\n    """one-liner"""');
    // no `#` field comments anymore: tooling ignores comments
    expect(src).not.toContain('# value with');

    // the same docs land on the EnvAttrs property, where hover works at the usage site
    expect(src).toContain([
      '    @property',
      '    def QUOTED(self) -> str:',
      ...quotedDoc.map((l) => (l ? `        ${l}` : '')),
      '        return self._values["QUOTED"]',
    ].join('\n'));
    expect(src).toContain('    def SHORT(self) -> str | None:\n        """one-liner"""\n        return self._values.get("SHORT")');
  });

  test('EnvAttrs class and a lazily-loaded ENV for attribute access', async () => {
    const { fields } = await loadFixtureFields();
    const src = generatePythonEnvSrc(fields);

    expect(src).toContain('class EnvAttrs:');
    expect(src).toContain('    def __init__(self, values: Env) -> None:');
    expect(src).toContain('    def APP_ENV(self) -> Literal["dev", "staging", "prod"]:');
    expect(src).toContain('    def DB_PORT(self) -> int | None:');
    // sensitive items are marked in their docs
    expect(src).toMatch(/def API_KEY\(self\) -> str:\n {8}"""🔐 Sensitive"""/);

    // ENV is declared for type checkers; the module __getattr__ that loads it is hidden from them
    expect(src).toContain('if TYPE_CHECKING:');
    expect(src).toContain('    ENV: EnvAttrs');
    expect(src).toContain('if not TYPE_CHECKING:\n    def __getattr__(name):');
    expect(src).toContain('globals()["ENV"] = env');
    // import stays side-effect-free
    expect(src).not.toMatch(/^ENV = /m);
  });

  test('deprecated items map to typing_extensions.deprecated on the property', async () => {
    const { fields } = await loadFixtureFields(outdent`
      # @defaultSensitive=false
      # ---
      # @deprecated="use NEW_KEY"
      OLD_KEY=a   # @public @required
      # @deprecated
      BARE_OLD=b  # @public @required
    `);
    const src = generatePythonEnvSrc(fields);
    expect(src).toContain('    from typing_extensions import deprecated');
    // runtime no-op fallback: the module has no dependencies
    expect(src).toContain('else:\n    def deprecated(_message):\n        return lambda fn: fn');
    expect(src).toContain('    @property\n    @deprecated("use NEW_KEY")\n    def OLD_KEY(self) -> str:');
    expect(src).toContain('    @deprecated("Deprecated")\n    def BARE_OLD(self) -> str:');
    expect(src).toContain('Deprecated: use NEW_KEY');

    // no deprecated items: no import and no fallback
    const plain = generatePythonEnvSrc((await loadFixtureFields()).fields);
    expect(plain).not.toContain('deprecated');
  });

  test('keys that would break the EnvAttrs class body are left off it (still in Env)', async () => {
    const { fields } = await loadFixtureFields(outdent`
      # @defaultSensitive=false
      # ---
      property=a  # @public @required
      _values=b   # @public @required
      __MANGLED=c # @public @required
      str=e       # @public @required
      Env=f       # @public @required
      OK=d        # @public @optional
    `);
    const src = generatePythonEnvSrc(fields);
    expect(src).toContain('    property: str');
    expect(src).toContain('    __MANGLED: str');
    expect(src).not.toContain('def property(');
    expect(src).not.toContain('def _values(');
    expect(src).not.toContain('def __MANGLED(');
    // a `str` / `Env` property would shadow the type in later annotations (mypy rejects it)
    expect(src).not.toContain('def str(');
    expect(src).not.toContain('def Env(');
    expect(src).toContain('def OK(self) -> str | None:');
    expect(src).toContain('def __init__(self, values: Env) -> None:');
    expect(src).toContain('# Keys omitted from EnvAttrs (reserved or mangled names): property, _values, __MANGLED, str, Env.');
  });

  test('composite (array/object) types map to list/dict annotations', async () => {
    const { fields } = await loadFixtureFields(COMPOSITE_TYPE_FIXTURE);
    const src = generatePythonEnvSrc(fields);
    expect(src).toContain('HOSTS: list[str]');
    expect(src).toContain('SCORES: NotRequired[list[float]]');
    expect(src).toContain('MODES: NotRequired[list[Literal["dev", "prod"]]]');
    expect(src).toContain('LIMITS: NotRequired[dict[str, float]]');
    // Literal only appears nested here — the import detection must still catch it
    expect(src).toContain('    from typing import Literal');
  });
});
