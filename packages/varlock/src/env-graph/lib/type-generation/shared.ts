import { ENCRYPTED_PREFIX } from '../../../runtime/crypto';
import type { TypeGenItemInfo } from '../config-item';
import type { CoercedType } from '../data-types';

export type { CoercedType };

export type FieldDocs = {
  description?: string;
  isDeprecated: boolean;
  deprecationMessage?: string;
  docsLinks: Array<{ url: string, description?: string }>;
  icon?: string;
};

export type ResolvedFieldType = {
  key: string;
  coerced: CoercedType;
  isRequired: boolean;
  isSensitive: boolean;
  docs: FieldDocs;
};

export function resolveFieldType(info: TypeGenItemInfo): ResolvedFieldType {
  // each data type declares what its coerce() outputs; types that don't (including
  // plugin-registered ones) coerce to strings
  const coerced = info.dataType?.coercedType ?? 'string';
  return {
    key: info.key,
    coerced,
    isRequired: info.isRequired && !info.isRequiredDynamic,
    isSensitive: info.isSensitive,
    docs: {
      description: info.description,
      isDeprecated: info.isDeprecated,
      deprecationMessage: info.deprecationMessage,
      docsLinks: info.docsLinks,
      icon: info.icon,
    },
  };
}

export function resolveFieldTypes(items: Array<TypeGenItemInfo>): Array<ResolvedFieldType> {
  return items.map(resolveFieldType);
}

/** Keys of sensitive fields, in schema order — emitted as a constant so consumers can build redaction/leak-scanning. */
export function getSensitiveKeys(fields: Array<ResolvedFieldType>): Array<string> {
  return fields.filter((f) => f.isSensitive).map((f) => f.key);
}

/**
 * The prefix marking an encrypted `__VARLOCK_ENV` blob (re-exported from runtime/crypto — the
 * format's owner). Generated modules can't decrypt (no key handling in the target language), so
 * loaders detect it and fail with a clear message rather than a raw JSON-parse error.
 */
export const ENCRYPTED_BLOB_PREFIX = ENCRYPTED_PREFIX;

/**
 * Loader error messages shared by every generated language module — one source of truth so the
 * wording can't drift between emitters. The missing-blob message calls out `--inject vars`
 * because `varlock run` itself recommends that mode, but it strips exactly the blob these
 * generated loaders parse.
 */
export const BLOB_MISSING_MSG = '__VARLOCK_ENV is not set — run your program via `varlock run` '
  + '(note: `--inject vars` omits the blob this module needs)';
export const BLOB_ENCRYPTED_MSG = '__VARLOCK_ENV is encrypted and this generated module cannot '
  + 'decrypt it — disable @encryptInjectedEnv for processes using a generated env module';

/**
 * The scalar kind shared by every member of an enum: all-integer members → 'int', numeric with
 * fractions → 'number', uniform 'string'/'boolean', or 'mixed'. Languages without literal-union
 * types (Go/Rust/PHP) use this to type the field so the loader can actually deserialize the
 * coerced wire value (a numeric enum's blob value is a number — typing it `string` would make
 * the generated loader fail at runtime).
 */
export function getEnumMemberKind(
  options: Array<string | number | boolean>,
): 'string' | 'int' | 'number' | 'boolean' | 'mixed' {
  const kinds = new Set(options.map((o) => typeof o));
  if (kinds.size > 1) return 'mixed';
  if (kinds.has('string')) return 'string';
  if (kinds.has('boolean')) return 'boolean';
  return options.every((o) => Number.isInteger(o)) ? 'int' : 'number';
}

/**
 * Neutralize the comment-closing star-slash sequence inside content flowing into a C-style block
 * comment (jsdoc/phpdoc) — otherwise a description or enum value could close the comment early,
 * a generated-source-injection primitive.
 */
export function escapeBlockCommentEnd(text: string): string {
  return text.replace(/\*\//g, '* /');
}

// A key usable verbatim as an identifier (a struct field / class property / TypedDict class-syntax
// name). @env-spec allows `.` and `-`, which are not — those keys can't be represented this way.
export const IDENTIFIER_SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Split fields into those representable as an identifier in the target language and those that
 * aren't (keys with `.`/`-`, or an optional language-specific reserved word). Emitters for languages
 * that turn keys into identifiers (Go/Rust/PHP/Python) generate only the `safe` ones and note the
 * `skipped` keys — the value is still injected as a raw env var, so nothing is silently lost.
 * (TypeScript quotes such keys instead of skipping, so it doesn't use this.)
 */
export function partitionRepresentableKeys(
  fields: Array<ResolvedFieldType>,
  isReserved?: (key: string) => boolean,
): { safe: Array<ResolvedFieldType>, skipped: Array<string> } {
  const safe: Array<ResolvedFieldType> = [];
  const skipped: Array<string> = [];
  for (const field of fields) {
    if (IDENTIFIER_SAFE_KEY.test(field.key) && !isReserved?.(field.key)) safe.push(field);
    else skipped.push(field.key);
  }
  return { safe, skipped };
}

/** A `[commentPrefix]`-style note listing keys left out of the typed structure (or `[]` if none). */
export function skippedKeysComment(skipped: Array<string>, commentPrefix: string): Array<string> {
  if (!skipped.length) return [];
  return [
    `${commentPrefix} Keys omitted from this typed module (not valid identifiers): ${skipped.join(', ')}.`,
    `${commentPrefix} They are still injected as raw environment variables.`,
  ];
}

/**
 * Some languages fold distinct keys onto the same identifier (Rust lowercases; Go PascalCases, so
 * `FOO_BAR`/`FOOBAR` collide). Emitters that do such a mapping call this to fail with a clear message
 * instead of emitting a duplicate field that only errors at compile time.
 */
export function assertNoFieldNameCollisions(
  fields: Array<ResolvedFieldType>,
  toFieldName: (key: string) => string,
  langLabel: string,
): void {
  const seen = new Map<string, string>();
  for (const field of fields) {
    const name = toFieldName(field.key);
    const prev = seen.get(name);
    if (prev !== undefined) {
      throw new Error(
        `${langLabel} code generation: keys \`${prev}\` and \`${field.key}\` both map to the field `
        + `name \`${name}\`. Rename one of them in your schema.`,
      );
    }
    seen.set(name, field.key);
  }
}

/**
 * Language-agnostic doc content lines for a field (description, docs links, deprecation, enum values).
 * Deliberately excludes the key name — repeating it as a comment is noise. Returns `[]` when there's
 * nothing worth a comment, so emitters can skip the doc entirely.
 */
export function getFieldDocLines(field: ResolvedFieldType): Array<string> {
  const lines: Array<string> = [];
  // split on any newline style so a CR-only description becomes multiple comment lines (rather than
  // one line with an embedded control char — a bare \r is a hard error inside a Rust doc comment)
  if (field.docs.description) lines.push(...field.docs.description.split(/\r\n|\r|\n/));
  for (const entry of field.docs.docsLinks) {
    lines.push(`Docs: ${[entry.url, entry.description].filter(Boolean).join(' | ')}`);
  }
  if (field.docs.isDeprecated) {
    lines.push(field.docs.deprecationMessage ? `Deprecated: ${field.docs.deprecationMessage}` : 'Deprecated');
  }
  if (typeof field.coerced === 'object' && 'enum' in field.coerced && field.coerced.enum.length) {
    lines.push(`Valid values: ${field.coerced.enum.map((o) => JSON.stringify(o)).join(' | ')}`);
  }
  // strip any remaining control chars (user-controlled description / deprecation / link text) so a
  // line can't break out of the generated comment in any target language
  return lines.map((line) => Array.from(line, (ch) => (ch.charCodeAt(0) < 0x20 ? ' ' : ch)).join('').trimEnd());
}
