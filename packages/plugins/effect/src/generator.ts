import type { CoercedType, ResolvedFieldType } from 'varlock/plugin-lib';

/** Effect major versions the generator can target. Each emits a different `Config` API surface. */
export type EffectMajor = 3 | 4;

export type GenerateOptions = {
  effectVersion: EffectMajor;
};

const UNSAFE_CODE_CHARS: Record<string, string> = {
  '<': '\\u003C',
  '>': '\\u003E',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
};

/**
 * Emit a value as a JavaScript literal that is safe to splice into generated source.
 * `JSON.stringify` alone leaves `<`, `>`, and the U+2028/U+2029 line terminators in place,
 * which can break out of a script tag or terminate a statement inside the generated module.
 */
function literal(value: unknown): string {
  return JSON.stringify(value).replace(/[<>\u2028\u2029]/g, (char) => UNSAFE_CODE_CHARS[char]);
}

function type(coerced: CoercedType): string {
  if (coerced === 'string') return 'string';
  if (coerced === 'int' || coerced === 'number') return 'number';
  if (coerced === 'boolean') return 'boolean';
  if (coerced === 'object') return 'Record<string, unknown>';

  if ('enum' in coerced) {
    return coerced.enum.map((member) => literal(member)).join(' | ') || 'never';
  }

  if ('arrayOf' in coerced) return `Array<${type(coerced.arrayOf)}>`;

  const recordValue = coerced.recordOf.values
    ? type(coerced.recordOf.values)
    : 'unknown';
  const keys = coerced.recordOf.keys;

  if (keys && typeof keys === 'object' && 'enum' in keys) {
    const key = keys.enum.map((member) => literal(String(member))).join(' | ') || 'never';
    return `Partial<Record<${key}, ${recordValue}>>`;
  }

  return `Record<string, ${recordValue}>`;
}

function composite(coerced: CoercedType): boolean {
  return coerced === 'object'
    || (typeof coerced === 'object' && ('arrayOf' in coerced || 'recordOf' in coerced));
}

function enumMembers(members: Array<unknown>, name: string): Array<string> {
  if (members.length === 0) {
    throw new Error(`Effect Config generation requires at least one enum value for ${name}`);
  }

  // Scalar environment values lose their original type; JSON composites do not.
  if (new Set(members.map(String)).size !== new Set(members).size) {
    throw new Error(`Effect Config generation cannot distinguish enum members with the same environment string for ${name}`);
  }

  return members.map((member) => literal(member));
}

/**
 * Effect 4: PascalCase primitive constructors (rc.113+), `Config.schema` + `effect/Schema` for
 * integers and JSON, `Redacted.make`, and the `redactErrors` helper to sanitize failures.
 */
function valueV4(field: ResolvedFieldType): string {
  const name = literal(field.key);
  const coerced = field.coerced;

  let config: string;

  if (coerced === 'string') config = `Config.String(${name})`;
  else if (coerced === 'boolean') config = `Config.Boolean(${name})`;
  else if (coerced === 'int') config = `Config.schema(Schema.Number.check(Schema.makeFilter(Number.isInteger, { expected: "an integer" })), ${name})`;
  else if (coerced === 'number') config = `Config.Number(${name})`;
  else if (typeof coerced === 'object' && 'enum' in coerced) {
    config = `Config.Literals([${enumMembers(coerced.enum, name).join(', ')}], ${name})`;
  } else if (composite(coerced)) {
    config = `Config.map(Config.schema(Schema.fromJsonString(Schema.Unknown), ${name}), (value) => value as ${type(coerced)})`;
  } else {
    throw new Error(`Unsupported Varlock coerced type: ${JSON.stringify(coerced)}`);
  }

  if (field.isSensitive) config = `Config.map(${config}, Redacted.make)`;
  if (!field.isRequired) config = `Config.option(${config})`;
  // Handle absence before sanitizing failures so optional secrets still become None.
  if (field.isSensitive) config = `redactErrors(${config}, ${name})`;

  return config;
}

/**
 * Effect 3: built-in primitive constructors, `Config.mapAttempt` for JSON, and `Config.redacted`,
 * which already replaces failure messages with `<redacted>`.
 */
function valueV3(field: ResolvedFieldType): string {
  const name = literal(field.key);
  const coerced = field.coerced;

  let config: string;

  if (coerced === 'string') config = `Config.string(${name})`;
  else if (coerced === 'boolean') config = `Config.boolean(${name})`;
  else if (coerced === 'int') config = `Config.integer(${name})`;
  else if (coerced === 'number') config = `Config.number(${name})`;
  else if (typeof coerced === 'object' && 'enum' in coerced) {
    config = `Config.literal(${enumMembers(coerced.enum, name).join(', ')})(${name})`;
  } else if (composite(coerced)) {
    config = `Config.mapAttempt(Config.string(${name}), (value) => JSON.parse(value) as ${type(coerced)})`;
  } else {
    throw new Error(`Unsupported Varlock coerced type: ${JSON.stringify(coerced)}`);
  }

  if (field.isSensitive) config = `Config.redacted(${config})`;
  if (!field.isRequired) config = `Config.option(${config})`;

  return config;
}

function comments(field: ResolvedFieldType): Array<string> {
  const lines: Array<string> = [];

  if (field.docs.description) {
    lines.push(...field.docs.description.split(/\r\n|\r|\n/));
  }

  for (const link of field.docs.docsLinks) {
    lines.push(`Docs: ${[link.url, link.description].filter(Boolean).join(' | ')}`);
  }

  if (field.docs.isDeprecated) {
    lines.push(field.docs.deprecationMessage
      ? `@deprecated ${field.docs.deprecationMessage}`
      : '@deprecated');
  }

  // Strip control characters from schema descriptions before emitting comments.
  // eslint-disable-next-line no-control-regex
  return lines.map((line) => line.replaceAll('*/', '* /').replace(/[\u0000-\u001f]/g, ' ').trimEnd());
}

function property(field: ResolvedFieldType, value: (field: ResolvedFieldType) => string): string {
  const docs = comments(field);
  const comment = docs.length === 0
    ? ''
    : `  /**\n${docs.map((line) => `   * ${line}`).join('\n')}\n   */\n`;

  return `${comment}  ${literal(field.key)}: ${value(field)},`;
}

function headerV4(fields: Array<ResolvedFieldType>): string {
  const hasSensitive = fields.some((field) => field.isSensitive);
  const imports = [
    'import * as Config from "effect/Config"',
    'import * as Effect from "effect/Effect"',
  ];
  if (hasSensitive) {
    imports.push('import * as Redacted from "effect/Redacted"');
  }
  if (hasSensitive || fields.some((field) => field.coerced === 'int' || composite(field.coerced))) {
    imports.push('import * as Schema from "effect/Schema"');
  }
  if (hasSensitive) {
    imports.push('import * as SchemaIssue from "effect/SchemaIssue"');
  }
  const helpers = hasSensitive ? `

function redactErrors<A>(config: Config.Config<A>, key: string): Config.Config<A> {
  return Config.orElse(config, () => {
    const error = new Schema.SchemaError(
      new SchemaIssue.Pointer([key], new SchemaIssue.InvalidValue({ message: "<redacted>" })),
    )
    // Config.fail is typed as Config<unknown> in this Effect release, but never succeeds.
    return Config.fail(error) as Config.Config<never>
  })
}
` : '';
  return imports.join('\n') + helpers;
}

function headerV3(): string {
  return [
    'import * as Config from "effect/Config"',
    'import * as Effect from "effect/Effect"',
  ].join('\n');
}

export function generateEffectConfig(fields: Array<ResolvedFieldType>, options: GenerateOptions): string {
  const { effectVersion } = options;
  if (effectVersion !== 3 && effectVersion !== 4) {
    throw new Error(`Unsupported Effect major version: ${String(effectVersion)}`);
  }

  const header = effectVersion === 4 ? headerV4(fields) : headerV3();
  const value = effectVersion === 4 ? valueV4 : valueV3;

  // Effect 3's `Config.all({})` throws at runtime on an empty struct, so an empty schema succeeds directly.
  const body = effectVersion === 3 && fields.length === 0
    ? 'Config.succeed({})'
    : `Config.all({\n${fields.map((field) => property(field, value)).join('\n')}\n})`;

  return `/**
 * Generated from .env.schema by Varlock for Effect ${effectVersion}. Do not edit by hand.
 */
${header}

export const config = ${body}

/** Loads environment values when executed, converting config failures to defects. */
export const generated = config.pipe(Effect.orDie)
`;
}
