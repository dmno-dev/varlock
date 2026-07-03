import { describe, expect, test } from 'vitest';

import { generatePhpEnvSrc } from '../../index';
import { loadFixtureFields } from './helpers';

describe('generatePhpEnvSrc', () => {
  test('emits a typed readonly class, SENSITIVE_KEYS, and a loader', async () => {
    const { fields } = await loadFixtureFields();
    const src = generatePhpEnvSrc(fields);

    expect(src).toMatch(/^<\?php/);
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

    expect(src).toContain('public static function load(): self');
    // cached accessor: parses once, no re-parse per access
    expect(src).toContain('public static function instance(): self');
    expect(src).toContain("getenv('__VARLOCK_ENV')");
  });
});
