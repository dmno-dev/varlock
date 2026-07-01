import { describe, expect, test } from 'vitest';

import { generateRustTypesSrc } from '../../index';
import { getSectionBetween, loadFixtureFields } from './helpers';

describe('generateRustTypesSrc', () => {
  test('maps non-string coerced and raw string types', async () => {
    const { fields } = await loadFixtureFields();
    const src = generateRustTypesSrc(fields);

    expect(src).toContain('pub struct CoercedEnvSchema');
    expect(src).toContain('pub struct PublicCoercedEnvSchema');
    expect(src).toContain('pub struct EnvSchemaAsStrings');

    expect(src).toContain('pub db_host: String,');
    expect(src).toContain('pub db_port: Option<i64>,');
    expect(src).toContain('pub debug: Option<bool>,');
    expect(src).toContain('pub app_env: String,');
    expect(src).toContain('pub config: Option<serde_json::Value>,');
    expect(src).toContain('Valid values: "dev" | "staging" | "prod"');

    const publicSection = getSectionBetween(src, 'pub struct PublicCoercedEnvSchema', 'pub struct EnvSchemaAsStrings');
    expect(publicSection).toContain('pub db_port: Option<i64>,');
    expect(publicSection).not.toContain('pub api_key:');
  });
});
