import type { CoercedType, ResolvedFieldType } from 'varlock/plugin-lib';

function type(coerced: CoercedType): string {
  if (coerced === 'string') return 'string';
  if (coerced === 'int' || coerced === 'number') return 'number';
  if (coerced === 'boolean') return 'boolean';
  if (coerced === 'object') return 'Record<string, unknown>';

  if ('enum' in coerced) {
    return coerced.enum.map((member) => JSON.stringify(member)).join(' | ');
  }

  if ('arrayOf' in coerced) return `Array<${type(coerced.arrayOf)}>`;

  const recordValue = coerced.recordOf.values
    ? type(coerced.recordOf.values)
    : 'unknown';
  const keys = coerced.recordOf.keys;

  if (keys && typeof keys === 'object' && 'enum' in keys) {
    const key = keys.enum.map((member) => JSON.stringify(member)).join(' | ');
    return `Partial<Record<${key}, ${recordValue}>>`;
  }

  return `Record<string, ${recordValue}>`;
}

function composite(coerced: CoercedType): boolean {
  return coerced === 'object'
    || (typeof coerced === 'object' && ('arrayOf' in coerced || 'recordOf' in coerced));
}

function value(field: ResolvedFieldType): string {
  const name = JSON.stringify(field.key);
  const coerced = field.coerced;

  let config: string;

  if (coerced === 'string') config = `Config.string(${name})`;
  else if (coerced === 'boolean') config = `Config.boolean(${name})`;
  else if (coerced === 'int') config = `Config.schema(Schema.Number.check(Schema.makeFilter(Number.isInteger, { expected: "an integer" })), ${name})`;
  else if (coerced === 'number') config = `Config.number(${name})`;
  else if (typeof coerced === 'object' && 'enum' in coerced) {
    if (coerced.enum.length === 0) {
      throw new Error(`Effect Config generation requires at least one enum value for ${name}`);
    }

    const members = coerced.enum.map((member) => JSON.stringify(member)).join(', ');
    config = `Config.literals([${members}], ${name})`;
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

function property(field: ResolvedFieldType): string {
  const docs = comments(field);
  const comment = docs.length === 0
    ? ''
    : `  /**\n${docs.map((line) => `   * ${line}`).join('\n')}\n   */\n`;

  return `${comment}  ${JSON.stringify(field.key)}: ${value(field)},`;
}

export function generateEffectConfig(fields: Array<ResolvedFieldType>): string {
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

  return `/**
 * Generated from .env.schema by Varlock. Do not edit by hand.
 */
${imports.join('\n')}${helpers}

export const config = Config.all({
${fields.map(property).join('\n')}
})

/** Loads environment values when executed, converting config failures to defects. */
export const generated = config.pipe(Effect.orDie)
`;
}
