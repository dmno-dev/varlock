import { describe, expect, test } from 'vitest';

import { generateGoTypesSrc } from '../../index';
import { getSectionBetween, loadFixtureFields } from './helpers';

describe('generateGoTypesSrc', () => {
  test('maps non-string coerced and raw string types', async () => {
    const { fields } = await loadFixtureFields();
    const src = generateGoTypesSrc(fields);

    expect(src).toContain('//go:build ignore');
    expect(src).toContain('type CoercedEnvSchema struct');
    expect(src).toContain('type PublicCoercedEnvSchema struct');
    expect(src).toContain('type EnvSchemaAsStrings struct');

    expect(src).toContain('DbHost string');
    expect(src).toContain('DbPort *int64');
    expect(src).toContain('Debug *bool');
    expect(src).toContain('AppEnv string');
    expect(src).toContain('Config *map[string]any');

    const stringsSection = src.split('type EnvSchemaAsStrings struct')[1] ?? '';
    expect(stringsSection).toContain('DbPort *string');
    expect(stringsSection).toContain('Debug *string');
    expect(stringsSection).not.toContain('*bool');
    expect(stringsSection).not.toContain('*int64');

    const publicSection = getSectionBetween(src, 'type PublicCoercedEnvSchema struct', 'type EnvSchemaAsStrings struct');
    expect(publicSection).toContain('DbPort *int64');
    expect(publicSection).not.toContain('ApiKey');
  });
});
