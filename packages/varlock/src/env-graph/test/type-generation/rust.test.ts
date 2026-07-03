import { describe, expect, test } from 'vitest';

import { generateRustEnvSrc } from '../../index';
import { loadFixtureFields } from './helpers';

describe('generateRustEnvSrc', () => {
  test('emits a serde struct, SENSITIVE_KEYS, and a loader', async () => {
    const { fields } = await loadFixtureFields();
    const src = generateRustEnvSrc(fields);

    expect(src).toContain('use serde::Deserialize;');
    expect(src).toContain('#[derive(Debug, Clone, Deserialize)]');
    expect(src).toContain('#[serde(rename_all = "SCREAMING_SNAKE_CASE")]');
    expect(src).toContain('pub struct Env {');
    expect(src).not.toContain('PublicCoercedEnvSchema');
    expect(src).not.toContain('EnvSchemaAsStrings');

    expect(src).toContain('pub db_host: String,');
    expect(src).toContain('pub db_port: Option<i64>,');
    expect(src).toContain('pub debug: Option<bool>,');
    expect(src).toContain('pub app_env: String,');
    expect(src).toContain('pub config: Option<serde_json::Value>,');
    expect(src).toContain('Valid values: "dev" | "staging" | "prod"');

    expect(src).toContain('pub const SENSITIVE_KEYS: &[&str] = &["API_KEY"];');
    expect(src).toContain('pub fn load() -> Result<Env, Box<dyn std::error::Error>> {');
    expect(src).toContain('std::env::var("__VARLOCK_ENV")');
  });
});
