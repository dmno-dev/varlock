import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

import { generateEffectConfig } from '../src/generator.js';
import { enumFields, field, fields } from './fixtures/fields.js';

const v4 = (input: Parameters<typeof generateEffectConfig>[0]) => generateEffectConfig(input, { effectVersion: 4 });
const v3 = (input: Parameters<typeof generateEffectConfig>[0]) => generateEffectConfig(input, { effectVersion: 3 });

describe('generateEffectConfig (Effect 4)', () => {
  test('reproduces the compiled runtime fixture', () => {
    const fixture = readFileSync(new URL('./effect4/env.generated.ts', import.meta.url), 'utf8');

    expect(v4(fields)).toBe(fixture);
  });

  test('generates an empty config', () => {
    const fixture = readFileSync(new URL('./effect4/empty.generated.ts', import.meta.url), 'utf8');

    expect(v4([])).toBe(fixture);
  });

  test('generates Effect Configs for scalar and enum fields', () => {
    const source = v4([
      field({ key: 'NAME' }),
      field({ key: 'ENABLED', coerced: 'boolean' }),
      field({ key: 'PORT', coerced: 'int' }),
      field({ key: 'RATIO', coerced: 'number' }),
      field({ key: 'STAGE', coerced: { enum: ['dev', 'prod'] } }),
    ]);

    expect(source).toContain('"NAME": Config.String("NAME")');
    expect(source).toContain('"ENABLED": Config.Boolean("ENABLED")');
    expect(source).toContain('"PORT": Config.schema(Schema.Number.check(Schema.makeFilter(Number.isInteger, { expected: "an integer" })), "PORT")');
    expect(source).toContain('"RATIO": Config.Number("RATIO")');
    expect(source).toContain('"STAGE": Config.Literals(["dev", "prod"], "STAGE")');
    expect(source).toContain('import * as Schema from "effect/Schema"');
    expect(source).not.toContain('"effect/Redacted"');
    expect(source).not.toContain('"effect/SchemaIssue"');
  });

  test('preserves sensitive and optional semantics', () => {
    const source = v4([
      field({
        key: 'TOKEN',
        isRequired: false,
        isSensitive: true,
      }),
    ]);

    expect(source).toContain(
      '"TOKEN": redactErrors(Config.option(Config.map(Config.String("TOKEN"), Redacted.make)), "TOKEN")',
    );
    expect(source).toContain('import * as Redacted from "effect/Redacted"');
    expect(source).toContain('import * as Schema from "effect/Schema"');
    expect(source).toContain('import * as SchemaIssue from "effect/SchemaIssue"');
  });

  test('parses Varlock composite values from their JSON wire format', () => {
    const source = v4([
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
    const source = v4([
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
    expect(() => v4([field({ key: 'EMPTY', coerced: { enum: [] } })])).toThrow('requires at least one enum value');
  });

  test('reproduces the compiled enum fixture', () => {
    const fixture = readFileSync(new URL('./effect4/enums.generated.ts', import.meta.url), 'utf8');
    expect(v4(enumFields)).toBe(fixture);
  });

  test.each([[1, '1'], ['1', 1], [true, 'true'], ['false', false]])('rejects enum members with the same wire value: %j', (...members) => {
    expect(() => v4([
      field({
        key: 'AMBIGUOUS', coerced: { enum: members }, isRequired: false, isSensitive: true,
      }),
    ])).toThrow('Effect Config generation cannot distinguish enum members with the same environment string for "AMBIGUOUS"');
  });

  test('allows repeated identical enum members', () => {
    expect(v4([field({ key: 'REPEATED', coerced: { enum: [1, 1] } })]))
      .toContain('Config.Literals([1, 1], "REPEATED")');
  });
});

describe('generateEffectConfig (Effect 3)', () => {
  test('reproduces the compiled runtime fixture', () => {
    const fixture = readFileSync(new URL('./effect3/env.generated.ts', import.meta.url), 'utf8');
    expect(v3(fields)).toBe(fixture);
  });

  test('reproduces the compiled enum fixture', () => {
    const fixture = readFileSync(new URL('./effect3/enums.generated.ts', import.meta.url), 'utf8');
    expect(v3(enumFields)).toBe(fixture);
  });

  test('generates an empty config', () => {
    const fixture = readFileSync(new URL('./effect3/empty.generated.ts', import.meta.url), 'utf8');
    expect(v3([])).toBe(fixture);
  });

  test('uses the Effect 3 primitive constructors and only imports Config and Effect', () => {
    const source = v3([
      field({ key: 'NAME' }),
      field({ key: 'ENABLED', coerced: 'boolean' }),
      field({ key: 'PORT', coerced: 'int' }),
      field({ key: 'RATIO', coerced: 'number' }),
      field({ key: 'STAGE', coerced: { enum: ['dev', 'prod'] } }),
      field({ key: 'HOSTS', coerced: { arrayOf: 'string' } }),
      field({ key: 'TOKEN', isRequired: false, isSensitive: true }),
    ]);

    expect(source).toContain('"NAME": Config.string("NAME")');
    expect(source).toContain('"ENABLED": Config.boolean("ENABLED")');
    expect(source).toContain('"PORT": Config.integer("PORT")');
    expect(source).toContain('"RATIO": Config.number("RATIO")');
    expect(source).toContain('"STAGE": Config.literal("dev", "prod")("STAGE")');
    expect(source).toContain('"HOSTS": Config.mapAttempt(Config.string("HOSTS"), (value) => JSON.parse(value) as Array<string>)');
    expect(source).toContain('"TOKEN": Config.option(Config.redacted(Config.string("TOKEN")))');
    expect(source).not.toContain('"effect/Schema"');
    expect(source).not.toContain('"effect/Redacted"');
    expect(source).not.toContain('redactErrors');
  });

  test('applies the same enum rules as Effect 4', () => {
    expect(() => v3([field({ key: 'EMPTY', coerced: { enum: [] } })])).toThrow('requires at least one enum value');
    expect(() => v3([field({ key: 'AMBIGUOUS', coerced: { enum: [1, '1'] } })])).toThrow('cannot distinguish enum members');
  });
});

test.each([3, 4] as const)('escapes characters that could break out of the generated module (Effect %s)', (effectVersion) => {
  const source = generateEffectConfig([
    field({ key: '</script>\u2028KEY', coerced: { enum: ['<b>', 'a\u2029b'] } }),
    field({ key: 'KEYS', coerced: { recordOf: { keys: { enum: ['</script>'] }, values: 'string' } } }),
  ], { effectVersion });

  expect(source).not.toContain('</script>');
  expect(source).not.toContain('\u2028');
  expect(source).not.toContain('\u2029');
  expect(source).toContain('"\\u003C/script\\u003E\\u2028KEY"');
  expect(source).toContain('"\\u003Cb\\u003E"');
  expect(source).toContain('"a\\u2029b"');
  expect(source).toContain('Partial<Record<"\\u003C/script\\u003E", string>>');
});

test('rejects unsupported Effect versions', () => {
  expect(() => generateEffectConfig([], { effectVersion: 5 as never })).toThrow('Unsupported Effect major version: 5');
});
