import { describe, expect, test } from 'vitest';
import outdent from 'outdent';

import { generateRustEnvSrc } from '../../index';
import { loadFixtureFields } from './helpers';

describe('generateRustEnvSrc', () => {
  test('emits a serde struct, SENSITIVE_KEYS, and a loader', async () => {
    const { fields } = await loadFixtureFields();
    const src = generateRustEnvSrc(fields);

    expect(src).toContain('use serde::Deserialize;');
    // Debug is a hand-written redacting impl (not derived), so secrets don't leak via `{:?}`
    expect(src).toContain('#[derive(Clone, Deserialize)]');
    expect(src).not.toContain('#[derive(Debug');
    expect(src).toContain('impl std::fmt::Debug for Env {');
    expect(src).toContain('.field("API_KEY", &"<redacted>")');
    expect(src).toContain('.field("DB_HOST", &self.db_host)');
    // per-field rename (exact env key) rather than a lossy struct-level rename_all
    expect(src).not.toContain('rename_all');
    expect(src).toContain('pub struct Env {');
    expect(src).not.toContain('PublicCoercedEnvSchema');
    expect(src).not.toContain('EnvSchemaAsStrings');

    expect(src).toContain('#[serde(rename = "DB_HOST")]');
    expect(src).toContain('pub db_host: String,');
    expect(src).toContain('pub db_port: Option<i64>,');
    expect(src).toContain('pub debug: Option<bool>,');
    expect(src).toContain('pub app_env: String,');
    expect(src).toContain('pub config: Option<serde_json::Value>,');
    expect(src).toContain('Valid values: "dev" | "staging" | "prod"');

    expect(src).toContain('pub const SENSITIVE_KEYS: &[&str] = &["API_KEY"];');
    expect(src).toContain('pub fn load() -> Result<Env, Box<dyn std::error::Error>> {');
    // no imposed global — callers load() once and hold/pass the value
    expect(src).not.toContain('LazyLock');
    expect(src).not.toContain('pub static ENV');
    expect(src).toContain('std::env::var("__VARLOCK_ENV")');
    // clear errors instead of a raw parse failure
    expect(src).toContain('__VARLOCK_ENV is not set');
    expect(src).toContain('is encrypted');
  });

  test('escapes keyword collisions with raw identifiers', async () => {
    const { fields } = await loadFixtureFields(outdent`
      # @defaultSensitive=false
      # ---
      TYPE=a       # @required @public
      MATCH=b      # @optional @public
      TRY=c        # @required @public
      YIELD=d      # @optional @public
    `);
    const src = generateRustEnvSrc(fields);
    expect(src).toContain('#[serde(rename = "TYPE")]');
    expect(src).toContain('pub r#type: String,');
    expect(src).toContain('pub r#match: Option<String>,');
    // reserved-but-unused keywords (2018+) also need escaping or the file won't compile
    expect(src).toContain('pub r#try: String,');
    expect(src).toContain('pub r#yield: Option<String>,');
  });

  test('numeric enums are typed by their member kind (blob carries the coerced value)', async () => {
    const { fields } = await loadFixtureFields(outdent`
      # @defaultSensitive=false
      # ---
      # @type=enum(1, 2, 3)
      INT_ENUM=2         # @required @public
      # @type=enum(0.5, 1.5)
      FLOAT_ENUM=0.5     # @required @public
      # @type=enum(one, 2)
      MIXED_ENUM=one     # @required @public
    `);
    const src = generateRustEnvSrc(fields);
    expect(src).toContain('pub int_enum: i64,');
    expect(src).toContain('pub float_enum: f64,');
    expect(src).toContain('pub mixed_enum: serde_json::Value,');
  });

  test('skips keys that are not valid identifiers (still tracked as sensitive)', async () => {
    const { fields } = await loadFixtureFields(outdent`
      # @defaultSensitive=false
      # ---
      OK_KEY=a       # @required @public
      MY-KEY=secret  # @required @sensitive
    `);
    const src = generateRustEnvSrc(fields);
    expect(src).toContain('pub ok_key: String,');
    // no struct field for the skipped key, but it stays in SENSITIVE_KEYS
    expect(src).not.toContain('rename = "MY-KEY"');
    expect(src).toContain('Keys omitted from this typed module (not valid identifiers): MY-KEY');
    expect(src).toContain('&["MY-KEY"]');
  });
});
