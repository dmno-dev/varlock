import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

import { generateEffectConfig } from '../src/generator.js';
import { enumFields, field, fields } from './fixtures/fields.js';

describe('generateEffectConfig', () => {
  test('reproduces the compiled runtime fixture', () => {
    const fixture = readFileSync(new URL('./fixtures/env.generated.ts', import.meta.url), 'utf8');

    expect(generateEffectConfig(fields)).toBe(fixture);
  });

  test('generates an empty config', () => {
    const fixture = readFileSync(new URL('./fixtures/empty.generated.ts', import.meta.url), 'utf8');

    expect(generateEffectConfig([])).toBe(fixture);
  });

  test('generates Effect Configs for scalar and enum fields', () => {
    const source = generateEffectConfig([
      field({ key: 'NAME' }),
      field({ key: 'ENABLED', coerced: 'boolean' }),
      field({ key: 'PORT', coerced: 'int' }),
      field({ key: 'RATIO', coerced: 'number' }),
      field({ key: 'STAGE', coerced: { enum: ['dev', 'prod'] } }),
    ]);

    expect(source).toContain('"NAME": Config.string("NAME")');
    expect(source).toContain('"ENABLED": Config.boolean("ENABLED")');
    expect(source).toContain('"PORT": Config.schema(Schema.Number.check(Schema.makeFilter(Number.isInteger, { expected: "an integer" })), "PORT")');
    expect(source).toContain('"RATIO": Config.number("RATIO")');
    expect(source).toContain('"STAGE": Config.literals(["dev", "prod"], "STAGE")');
    expect(source).toContain('import * as Schema from "effect/Schema"');
    expect(source).not.toContain('"effect/Redacted"');
    expect(source).not.toContain('"effect/SchemaIssue"');
  });

  test('preserves sensitive and optional semantics', () => {
    const source = generateEffectConfig([
      field({
        key: 'TOKEN',
        isRequired: false,
        isSensitive: true,
      }),
    ]);

    expect(source).toContain(
      '"TOKEN": redactErrors(Config.option(Config.map(Config.string("TOKEN"), Redacted.make)), "TOKEN")',
    );
    expect(source).toContain('import * as Redacted from "effect/Redacted"');
    expect(source).toContain('import * as Schema from "effect/Schema"');
    expect(source).toContain('import * as SchemaIssue from "effect/SchemaIssue"');
  });

  test('parses Varlock composite values from their JSON wire format', () => {
    const source = generateEffectConfig([
      field({ key: 'HOSTS', coerced: { arrayOf: 'string' } }),
      field({
        key: 'LIMITS',
        coerced: {
          recordOf: {
            keys: { enum: ['us', 'eu'] },
            values: 'int',
          },
        },
      }),
      field({ key: 'DATA', coerced: 'object' }),
    ]);

    expect(source).toContain(
      'Config.map(Config.schema(Schema.fromJsonString(Schema.Unknown), "HOSTS"), (value) => value as Array<string>)',
    );
    expect(source).toContain(
      'value as Partial<Record<"us" | "eu", number>>',
    );
    expect(source).toContain(
      'value as Record<string, unknown>',
    );
    expect(source).toContain('import * as Schema from "effect/Schema"');
    expect(source).not.toContain('"effect/Redacted"');
  });

  test('emits safe multiline documentation', () => {
    const source = generateEffectConfig([
      field({
        key: 'OLD_KEY',
        docs: {
          description: 'First line\ncloses */ comment',
          docsLinks: [{ url: 'https://example.com', description: 'Reference' }],
          isDeprecated: true,
          deprecationMessage: 'Use NEW_KEY',
        },
      }),
    ]);

    expect(source).toContain('* First line');
    expect(source).toContain('* closes * / comment');
    expect(source).toContain('* Docs: https://example.com | Reference');
    expect(source).toContain('* @deprecated Use NEW_KEY');
  });

  test('rejects empty enums', () => {
    expect(() => generateEffectConfig([field({ key: 'EMPTY', coerced: { enum: [] } })])).toThrow('requires at least one enum value');
  });

  test('reproduces the compiled enum fixture', () => {
    const fixture = readFileSync(new URL('./fixtures/enums.generated.ts', import.meta.url), 'utf8');
    expect(generateEffectConfig(enumFields)).toBe(fixture);
  });

  test.each([[1, '1'], ['1', 1], [true, 'true'], ['false', false]])('rejects enum members with the same wire value: %j', (...members) => {
    expect(() => generateEffectConfig([
      field({
        key: 'AMBIGUOUS', coerced: { enum: members }, isRequired: false, isSensitive: true,
      }),
    ])).toThrow('Effect Config generation cannot distinguish enum members with the same environment string for "AMBIGUOUS"');
  });

  test('allows repeated identical enum members', () => {
    expect(generateEffectConfig([field({ key: 'REPEATED', coerced: { enum: [1, 1] } })]))
      .toContain('Config.literals([1, 1], "REPEATED")');
  });
});
