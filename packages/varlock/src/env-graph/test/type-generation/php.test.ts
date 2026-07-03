import { describe, expect, test } from 'vitest';
import outdent from 'outdent';

import { resolveFieldTypes, generatePhpEnvSrc } from '../../index';
import { loadFixtureFields, loadGraph } from './helpers';

describe('generatePhpEnvSrc', () => {
  test('emits a typed readonly class, SENSITIVE_KEYS, and a loader', async () => {
    const { fields } = await loadFixtureFields();
    const src = generatePhpEnvSrc(fields);

    expect(src).toMatch(/^<\?php/);
    expect(src).toContain('declare(strict_types=1);');
    expect(src).toContain('final class Env');
    // the floating @phpstan-type approach (not recognized by PHPStan) is gone
    expect(src).not.toContain('@phpstan-type');

    expect(src).toContain("public const SENSITIVE_KEYS = ['API_KEY'];");

    // required params first, optional (nullable, defaulted) after
    expect(src).toContain('public readonly string $DB_HOST,');
    expect(src).toContain('public readonly ?int $DB_PORT = null,');
    expect(src).toContain('public readonly ?bool $DEBUG = null,');
    expect(src).toContain('public readonly string $APP_ENV,');
    expect(src).toContain('@var "dev"|"staging"|"prod"');
    expect(src).toContain('public readonly ?array $CONFIG = null,');
    expect(src).toContain('@var array<string, mixed>|null');

    // required keys throw a clear error if missing; optional keys default to null
    expect(src).toContain("['DB_HOST']['value'] ?? throw new \\RuntimeException('varlock: missing required key DB_HOST");
    expect(src).toContain("['DB_PORT']['value'] ?? null");
    expect(src).toContain('public static function load(): self');
    // no imposed singleton — callers load() once and hold/inject the value
    expect(src).not.toContain('function instance(');
    expect(src).not.toContain('$cached');
    expect(src).toContain("getenv('__VARLOCK_ENV')");
    // clear errors instead of a raw JsonException
    expect(src).toContain('__VARLOCK_ENV is not set');
    expect(src).toContain('is encrypted');
  });

  test('supports namespace= and class= options', async () => {
    const { fields } = await loadFixtureFields();
    const src = generatePhpEnvSrc(fields, { namespace: 'App\\Config', className: 'AppEnv' });
    expect(src).toContain('namespace App\\Config;');
    expect(src).toContain('final class AppEnv');
    // declare(strict_types=1) must come before the namespace
    expect(src.indexOf('declare(strict_types=1);')).toBeLessThan(src.indexOf('namespace App'));
  });

  test('rejects an invalid namespace or class name', async () => {
    const { fields } = await loadFixtureFields();
    expect(() => generatePhpEnvSrc(fields, { className: 'Not Valid' })).toThrow(/class/);
    expect(() => generatePhpEnvSrc(fields, { namespace: '9bad' })).toThrow(/namespace/);
  });

  test('escapes `*/` in enum @var so a value cannot break out of the docblock', async () => {
    const g = await loadGraph({
      envFile: outdent`
        # @defaultSensitive=false
        # ---
        # @type=enum("a*/ evil", "b")
        MODE=b   # @public @required
      `,
    });
    const items = [await g.configSchema.MODE.getTypeGenInfo()];
    const src = generatePhpEnvSrc(resolveFieldTypes(items));
    // the raw `*/` must not survive into the source
    expect(src).not.toContain('a*/ evil');
    expect(src).toContain('a* / evil');
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
    const src = generatePhpEnvSrc(resolveFieldTypes(items));
    expect(src).toContain('$OK_KEY');
    // no constructor property for the skipped key, but it stays in SENSITIVE_KEYS
    expect(src).not.toContain('$MY-KEY');
    expect(src).toContain('Keys omitted from this typed module (not valid identifiers): MY-KEY');
    expect(src).toContain("SENSITIVE_KEYS = ['MY-KEY']");
  });
});
