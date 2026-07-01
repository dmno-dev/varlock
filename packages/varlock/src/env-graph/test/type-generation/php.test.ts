import { describe, expect, test } from 'vitest';

import { generatePhpTypesSrc } from '../../index';
import { getSectionBetween, loadFixtureFields } from './helpers';

describe('generatePhpTypesSrc', () => {
  test('maps non-string coerced and raw string types', async () => {
    const { fields } = await loadFixtureFields();
    const src = generatePhpTypesSrc(fields);

    expect(src).toMatch(/^<\?php/);
    expect(src).toContain('@phpstan-type CoercedEnvSchema');
    expect(src).toContain('@phpstan-type PublicCoercedEnvSchema');
    expect(src).toContain('@phpstan-type EnvSchemaAsStrings');

    expect(src).toContain('DB_HOST: string');
    expect(src).toContain('DB_PORT?: int');
    expect(src).toContain('DEBUG?: bool');
    expect(src).toContain('APP_ENV: "dev"|"staging"|"prod"');
    expect(src).toContain('CONFIG?: array<string, mixed>');

    expect(src).toContain('DEBUG?: \'true\'|\'false\'');
    expect(src).toContain('DB_PORT?: string');

    const publicSection = getSectionBetween(src, '@phpstan-type PublicCoercedEnvSchema', '@phpstan-type EnvSchemaAsStrings');
    expect(publicSection).toContain('DB_PORT?: int');
    expect(publicSection).not.toContain('API_KEY');
  });
});
