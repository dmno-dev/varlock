import fs from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_IGNORED_DIRS = [
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  'vendor',
  '.venv',
] as const;

const DEFAULT_MAX_FILE_SIZE_BYTES = 1024 * 1024;
const DEFAULT_CONCURRENCY = 50;
const ENV_KEY_IDENTIFIER_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

// A subdirectory containing one of these files is treated as a separate project /
// workspace package, so we don't descend into it while scanning the parent. This keeps
// a monorepo root's `audit`/`init` from pulling in env var references that belong to
// child packages. `package.json` covers JS workspace packages (even before they've run
// `varlock init`, and regardless of package manager); `.env.schema` covers
// already-initialized and non-JS projects.
const NESTED_PROJECT_MARKERS = new Set(['package.json', '.env.schema']);

const LANGUAGE_BY_EXTENSION: Record<string, ScannerLanguage> = {
  '.js': 'js-like',
  '.mjs': 'js-like',
  '.cjs': 'js-like',
  '.jsx': 'js-like',
  '.ts': 'js-like',
  '.mts': 'js-like',
  '.cts': 'js-like',
  '.tsx': 'js-like',
  '.vue': 'js-like',
  '.svelte': 'js-like',
  '.astro': 'js-like',
  '.mdx': 'js-like',

  '.py': 'python',
  '.go': 'go',
  '.rb': 'ruby',
  '.php': 'php',
  '.rs': 'rust',
  '.java': 'java',
  '.cs': 'csharp',
};

type ScannerLanguage = 'js-like' | 'python' | 'go' | 'ruby' | 'php' | 'rust' | 'java' | 'csharp';

export type EnvVarSyntax = 'process.env.member'
  | 'process.env.bracket'
  | 'process.env.destructure'
  | 'import.meta.env.member'
  | 'import.meta.env.bracket'
  | 'import.meta.env.destructure'
  | 'ENV.member'
  | 'ENV.bracket'
  | 'ENV.destructure'
  | 'custom'
  | 'python.environ'
  | 'python.getenv'
  | 'go.getenv'
  | 'ruby.env'
  | 'ruby.fetch'
  | 'php.getenv'
  | 'php._env'
  | 'php._server'
  | 'rust.getenv'
  | 'java.getenv'
  | 'csharp.getenv';

export interface EnvVarReference {
  key: string;
  filePath: string;
  lineNumber: number;
  columnNumber: number;
  syntax: EnvVarSyntax;
}

/** A custom scan pattern, optionally restricted to certain file extensions. */
export interface ExtraScanPattern {
  pattern: RegExp;
  /**
   * File types this pattern applies to, given as extensions with or without a leading
   * dot and matched case-insensitively (`tf`, `.tf` and `.TF` are the same thing).
   *
   * Naming an extension the built-in scanner doesn't handle (`.tf`, `.yaml`, `.sh`)
   * also brings those files into the scan - they are otherwise never read. Such files
   * have no known language, so they're matched over their raw contents: the built-in
   * patterns don't apply, and commented-out lines aren't skipped.
   *
   * An empty or omitted list means every file the built-in discovery already picks up.
   */
  fileTypes?: Array<string>;
}

export interface ScanCodeEnvVarsOptions {
  cwd?: string;
  concurrency?: number;
  maxFileSizeBytes?: number;
  // legacy option, treated as additional excludes
  ignoredDirs?: Array<string>;
  /**
   * Project-supplied patterns (e.g. from the `@auditExtraPatterns` root
   * decorator), run after the built-in patterns. The first capture group is
   * the env key; patterns without one match nothing. The global flag is
   * added when missing.
   *
   * Unlike the built-ins these run over content where only comments are
   * masked - string bodies are left intact, so a capture that isn't a bare
   * env-key identifier (`cfg.get('app.db.url')`) still matches.
   *
   * A bare RegExp applies to every file the built-in discovery picks up. Use
   * the {@link ExtraScanPattern} form to scope a pattern to particular file
   * types, which also brings in file types the built-ins don't cover.
   */
  extraPatterns?: Array<RegExp | ExtraScanPattern>;
}

export interface ScanCodeEnvVarsResult {
  keys: Array<string>;
  references: Array<EnvVarReference>;
  scannedFilesCount: number;
}

interface SimplePattern {
  regex: RegExp;
  syntax: EnvVarSyntax;
}

const PATTERNS_BY_LANGUAGE: Record<ScannerLanguage, Array<SimplePattern>> = {
  'js-like': [
    {
      regex: /\bprocess\.env\.([A-Za-z_][A-Za-z0-9_]*)\b/g,
      syntax: 'process.env.member',
    },
    {
      regex: /\bprocess\.env\[\s*['"`]([A-Za-z_][A-Za-z0-9_]*)['"`]\s*\]/g,
      syntax: 'process.env.bracket',
    },
    {
      regex: /\bimport\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)\b/g,
      syntax: 'import.meta.env.member',
    },
    {
      regex: /\bimport\.meta\.env\[\s*['"`]([A-Za-z_][A-Za-z0-9_]*)['"`]\s*\]/g,
      syntax: 'import.meta.env.bracket',
    },
    {
      regex: /\bENV\.([A-Za-z_][A-Za-z0-9_]*)\b/g,
      syntax: 'ENV.member',
    },
    {
      regex: /\bENV\[\s*['"`]([A-Za-z_][A-Za-z0-9_]*)['"`]\s*\]/g,
      syntax: 'ENV.bracket',
    },
  ],
  python: [
    {
      regex: /\bos\.environ\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g,
      syntax: 'python.environ',
    },
    {
      regex: /\bos\.getenv\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
      syntax: 'python.getenv',
    },
  ],
  go: [
    {
      regex: /\bos\.(?:Getenv|LookupEnv)\(\s*"([A-Za-z_][A-Za-z0-9_]*)"\s*\)/g,
      syntax: 'go.getenv',
    },
  ],
  ruby: [
    {
      regex: /\bENV\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g,
      syntax: 'ruby.env',
    },
    {
      regex: /\bENV\.fetch\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
      syntax: 'ruby.fetch',
    },
  ],
  php: [
    {
      regex: /\bgetenv\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
      syntax: 'php.getenv',
    },
    {
      regex: /\$_ENV\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g,
      syntax: 'php._env',
    },
    {
      regex: /\$_SERVER\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g,
      syntax: 'php._server',
    },
  ],
  rust: [
    {
      regex: /\bstd::env::(?:var|var_os)\(\s*"([A-Za-z_][A-Za-z0-9_]*)"\s*\)/g,
      syntax: 'rust.getenv',
    },
  ],
  java: [
    {
      regex: /\bSystem\.getenv\(\s*"([A-Za-z_][A-Za-z0-9_]*)"\s*\)/g,
      syntax: 'java.getenv',
    },
  ],
  csharp: [
    {
      regex: /\bEnvironment\.GetEnvironmentVariable\(\s*"([A-Za-z_][A-Za-z0-9_]*)"\s*\)/g,
      syntax: 'csharp.getenv',
    },
  ],
};

const JS_DESTRUCTURE_PATTERNS: Array<{ regex: RegExp, syntax: EnvVarSyntax }> = [
  {
    regex: /\{([^}]*)\}\s*=\s*process\.env\b/g,
    syntax: 'process.env.destructure',
  },
  {
    regex: /\{([^}]*)\}\s*=\s*import\.meta\.env\b/g,
    syntax: 'import.meta.env.destructure',
  },
  {
    regex: /\{([^}]*)\}\s*=\s*ENV\b/g,
    syntax: 'ENV.destructure',
  },
];

async function discoverSourceFiles(
  cwd: string,
  ignoredDirs: Set<string>,
  widenedExtensions: Set<string>,
): Promise<Array<string>> {
  const filePaths: Array<string> = [];

  async function walk(dir: string, isRoot: boolean): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    // Don't descend into nested projects / workspace packages (the scan root is exempt).
    // We detect the boundary from the directory listing we already have - no extra stat.
    if (!isRoot && entries.some((entry) => entry.isFile() && NESTED_PROJECT_MARKERS.has(entry.name))) {
      return;
    }

    const subdirWalks: Array<Promise<void>> = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (ignoredDirs.has(entry.name)) continue;
        subdirWalks.push(walk(path.join(dir, entry.name), false));
      } else if (entry.isFile()) {
        const extension = path.extname(entry.name).toLowerCase();
        if (!(extension in LANGUAGE_BY_EXTENSION) && !widenedExtensions.has(extension)) continue;
        filePaths.push(path.join(dir, entry.name));
      }
    }
    await Promise.all(subdirWalks);
  }

  await walk(cwd, true);
  return filePaths;
}

function extractDestructuredKeys(body: string): Array<{ key: string, relativeIndex: number }> {
  const found: Array<{ key: string, relativeIndex: number }> = [];
  const propPattern = /(^|,)\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*[A-Za-z_][A-Za-z0-9_]*)?\s*(?:=[^,]+)?\s*(?=,|$)/g;
  for (const match of body.matchAll(propPattern)) {
    const key = match[2];
    if (!key) continue;
    const wholeMatch = match[0] || '';
    const keyIndexInWhole = wholeMatch.indexOf(key);
    const relativeIndex = (match.index ?? 0) + (keyIndexInWhole >= 0 ? keyIndexInWhole : 0);
    found.push({ key, relativeIndex });
  }
  return found;
}

function getNewlineIndices(content: string): Array<number> {
  const indices: Array<number> = [];
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) indices.push(i);
  }
  return indices;
}

function indexToLineAndColumn(
  content: string,
  newlineIndices: Array<number>,
  index: number,
): { lineNumber: number, columnNumber: number } {
  let lo = 0;
  let hi = newlineIndices.length;

  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (newlineIndices[mid] < index) lo = mid + 1;
    else hi = mid;
  }

  const lineNumber = lo + 1;
  const lineStartIndex = lo === 0 ? 0 : newlineIndices[lo - 1] + 1;

  return {
    lineNumber,
    columnNumber: index - lineStartIndex + 1,
  };
}

function buildReference(
  filePath: string,
  content: string,
  newlineIndices: Array<number>,
  index: number,
  key: string,
  syntax: EnvVarSyntax,
): EnvVarReference {
  const { lineNumber, columnNumber } = indexToLineAndColumn(content, newlineIndices, index);
  return {
    filePath,
    key,
    lineNumber,
    columnNumber,
    syntax,
  };
}

/**
 * Blank a `//` comment through to (but not including) its newline, returning the index
 * just past it. Layout is preserved so byte offsets stay valid.
 */
function maskLineComment(chars: Array<string>, startIndex: number): number {
  let i = startIndex;
  while (i < chars.length && chars[i] !== '\n') {
    chars[i] = ' ';
    i++;
  }
  return i;
}

/** Blank a `/* *\/` comment including its delimiters, preserving newlines. */
function maskBlockComment(chars: Array<string>, startIndex: number): number {
  let i = startIndex;
  while (i < chars.length) {
    const isEnd = chars[i] === '*' && chars[i + 1] === '/';
    if (chars[i] !== '\n') chars[i] = ' ';
    if (isEnd) {
      chars[i + 1] = ' ';
      return i + 2;
    }
    i++;
  }
  return i;
}

function skipQuotedWithoutMask(chars: Array<string>, startIndex: number, quoteChar: '\'' | '"'): number {
  let i = startIndex + 1;
  while (i < chars.length) {
    const ch = chars[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quoteChar) {
      i++;
      return i;
    }
    i++;
  }
  return i;
}

/**
 * Walk a template literal leaving its text alone. "WithoutMask" refers to the template
 * text only: comments inside `${...}` are still blanked, since those are code comments
 * like any other.
 */
function skipTemplateWithoutMask(chars: Array<string>, startIndex: number): number {
  let i = startIndex + 1;
  while (i < chars.length) {
    const ch = chars[i];
    const next = chars[i + 1];

    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '`') {
      i++;
      return i;
    }
    if (ch === '$' && next === '{') {
      i += 2;
      let depth = 1;
      while (i < chars.length && depth > 0) {
        const exprCh = chars[i];
        const exprNext = chars[i + 1];

        if (exprCh === '\\') {
          i += 2;
          continue;
        }
        // Quoted text is stepped over before testing for comment delimiters, so a `//`
        // in a URL or a `/*` in a string doesn't blank the live code that follows it.
        if (exprCh === '\'' || exprCh === '"') {
          i = skipQuotedWithoutMask(chars, i, exprCh);
          continue;
        }
        if (exprCh === '`') {
          i = skipTemplateWithoutMask(chars, i);
          continue;
        }
        if (exprCh === '/' && exprNext === '/') {
          i = maskLineComment(chars, i);
          continue;
        }
        if (exprCh === '/' && exprNext === '*') {
          i = maskBlockComment(chars, i);
          continue;
        }
        if (exprCh === '{') depth++;
        else if (exprCh === '}') depth--;
        i++;
      }
      continue;
    }
    i++;
  }
  return i;
}

function skipAndMaskQuotedString(chars: Array<string>, startIndex: number, quoteChar: '\'' | '"'): number {
  let i = startIndex + 1;
  while (i < chars.length) {
    const ch = chars[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quoteChar) {
      i++;
      break;
    }
    i++;
  }

  const endExclusive = i;
  const inner = chars.slice(startIndex + 1, Math.max(startIndex + 1, endExclusive - 1)).join('');
  const keepInner = ENV_KEY_IDENTIFIER_REGEX.test(inner);
  if (!keepInner) {
    for (let idx = startIndex + 1; idx < endExclusive - 1; idx++) {
      if (chars[idx] !== '\n') chars[idx] = ' ';
    }
  }
  return endExclusive;
}

function skipAndMaskTemplateLiteral(chars: Array<string>, startIndex: number): number {
  let i = startIndex + 1;
  let segmentStart = i;
  const literalSegments: Array<{ start: number, endExclusive: number }> = [];
  let hasInterpolation = false;

  while (i < chars.length) {
    const ch = chars[i];
    const next = chars[i + 1];

    if (ch === '\\') {
      i += 2;
      continue;
    }

    if (ch === '`') {
      literalSegments.push({ start: segmentStart, endExclusive: i });
      i++;
      break;
    }

    if (ch === '$' && next === '{') {
      hasInterpolation = true;
      literalSegments.push({ start: segmentStart, endExclusive: i });
      i += 2;
      let depth = 1;
      while (i < chars.length && depth > 0) {
        const exprCh = chars[i];
        const exprNext = chars[i + 1];

        if (exprCh === '\\') {
          i += 2;
          continue;
        }

        if (exprCh === '\'' || exprCh === '"') {
          i = skipQuotedWithoutMask(chars, i, exprCh);
          continue;
        }

        if (exprCh === '`') {
          i = skipTemplateWithoutMask(chars, i);
          continue;
        }

        if (exprCh === '{') depth++;
        else if (exprCh === '}') depth--;

        if (depth === 0) {
          i++;
          break;
        }

        // Comments inside an interpolation are code comments, not template text, so
        // they're blanked like any other comment - otherwise a commented-out
        // `process.env.X` inside `${...}` reads as a live reference.
        if (exprCh === '/' && exprNext === '/') {
          i = maskLineComment(chars, i);
          continue;
        }
        if (exprCh === '/' && exprNext === '*') {
          i = maskBlockComment(chars, i);
          continue;
        }

        i++;
      }
      segmentStart = i;
      continue;
    }

    i++;
  }

  const endExclusive = i;
  if (!hasInterpolation) {
    const inner = chars.slice(startIndex + 1, Math.max(startIndex + 1, endExclusive - 1)).join('');
    if (!ENV_KEY_IDENTIFIER_REGEX.test(inner)) {
      for (let idx = startIndex + 1; idx < endExclusive - 1; idx++) {
        if (chars[idx] !== '\n') chars[idx] = ' ';
      }
    }
    return endExclusive;
  }

  for (const segment of literalSegments) {
    for (let idx = segment.start; idx < segment.endExclusive; idx++) {
      if (chars[idx] !== '\n') chars[idx] = ' ';
    }
  }

  return endExclusive;
}

/**
 * Blank out everything the scanner should not match against, preserving byte offsets
 * (and therefore line/column) by replacing masked characters with spaces.
 *
 * Comments are always masked. String bodies are masked too by default, which keeps the
 * built-in patterns from matching `process.env.FOO` written inside a raw string - but
 * that same masking blanks any string that isn't a bare env-key identifier, so custom
 * patterns opt out via `maskStringBodies: false`.
 */
function maskCommentsPreserveLayout(
  content: string,
  language: ScannerLanguage,
  opts: { maskStringBodies?: boolean } = {},
): string {
  const maskStringBodies = opts.maskStringBodies ?? true;
  const chars = content.split('');

  const supportsHashComments = language === 'python' || language === 'ruby' || language === 'php';
  const supportsSlashComments = language !== 'python' && language !== 'ruby';

  let i = 0;
  let inLineComment = false;
  let inBlockComment = false;

  while (i < chars.length) {
    const ch = chars[i];
    const next = chars[i + 1];

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
      } else {
        chars[i] = ' ';
      }
      i++;
      continue;
    }

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        chars[i] = ' ';
        chars[i + 1] = ' ';
        inBlockComment = false;
        i += 2;
        continue;
      }
      if (ch !== '\n') chars[i] = ' ';
      i++;
      continue;
    }

    if (supportsSlashComments && ch === '/' && next === '/') {
      chars[i] = ' ';
      chars[i + 1] = ' ';
      inLineComment = true;
      i += 2;
      continue;
    }
    if (supportsSlashComments && ch === '/' && next === '*') {
      chars[i] = ' ';
      chars[i + 1] = ' ';
      inBlockComment = true;
      i += 2;
      continue;
    }
    if (supportsHashComments && ch === '#') {
      chars[i] = ' ';
      inLineComment = true;
      i++;
      continue;
    }

    if (ch === '\'') {
      i = maskStringBodies
        ? skipAndMaskQuotedString(chars, i, '\'')
        : skipQuotedWithoutMask(chars, i, '\'');
      continue;
    }
    if (ch === '"') {
      i = maskStringBodies
        ? skipAndMaskQuotedString(chars, i, '"')
        : skipQuotedWithoutMask(chars, i, '"');
      continue;
    }
    if (ch === '`' && (language === 'js-like' || language === 'go')) {
      i = maskStringBodies
        ? skipAndMaskTemplateLiteral(chars, i)
        : skipTemplateWithoutMask(chars, i);
      continue;
    }

    i++;
  }

  return chars.join('');
}

/** Run already-normalized custom patterns over already-prepared content. */
function matchExtraPatterns(
  filePath: string,
  content: string,
  extraPatterns: Array<NormalizedExtraPattern>,
  precomputedNewlineIndices?: Array<number>,
): Array<EnvVarReference> {
  if (!extraPatterns.length) return [];
  const newlineIndices = precomputedNewlineIndices ?? getNewlineIndices(content);
  const references: Array<EnvVarReference> = [];
  for (const { regex } of extraPatterns) {
    for (const match of content.matchAll(regex)) {
      const key = match[1];
      if (!key) continue;
      references.push(buildReference(filePath, content, newlineIndices, match.index ?? 0, key, 'custom'));
    }
  }
  return references;
}

async function scanFileForEnvVarReferences(
  filePath: string,
  maxFileSizeBytes: number,
  extraPatterns: Array<NormalizedExtraPattern> = [],
): Promise<Array<EnvVarReference>> {
  let fileStat;
  try {
    fileStat = await fs.stat(filePath);
  } catch {
    return [];
  }

  if (!fileStat.isFile() || fileStat.size > maxFileSizeBytes) return [];

  let rawContent: string;
  try {
    rawContent = await fs.readFile(filePath, 'utf-8');
  } catch {
    return [];
  }
  if (!rawContent || rawContent.includes('\0')) return [];

  const extension = path.extname(filePath).toLowerCase();
  const language = LANGUAGE_BY_EXTENSION[extension];

  // An unscoped pattern covers the languages the scanner already knows. Files that are
  // only in the walk because a pattern named their extension are matched by that
  // pattern alone, so one rule widening the scan can't silently change another's reach.
  const applicablePatterns = extraPatterns.filter(({ extensions }) => {
    if (extensions) return extensions.has(extension);
    return !!language;
  });

  // A widened file has no language: no built-in patterns apply, and with no known
  // comment syntax its raw content is what gets matched.
  if (!language) return matchExtraPatterns(filePath, rawContent, applicablePatterns);

  // Masking preserves byte offsets, so both variants share the raw file's newline
  // positions and reference line/columns stay comparable.
  const scanContent = maskCommentsPreserveLayout(rawContent, language);
  const newlineIndices = getNewlineIndices(rawContent);
  const references: Array<EnvVarReference> = [];

  for (const pattern of PATTERNS_BY_LANGUAGE[language]) {
    for (const match of scanContent.matchAll(pattern.regex)) {
      const key = match[1];
      if (!key) continue;
      references.push(buildReference(filePath, scanContent, newlineIndices, match.index ?? 0, key, pattern.syntax));
    }
  }

  if (language === 'js-like') {
    for (const pattern of JS_DESTRUCTURE_PATTERNS) {
      for (const match of scanContent.matchAll(pattern.regex)) {
        const body = match[1];
        if (!body) continue;

        const bodyOffset = (match.index ?? 0) + match[0].indexOf(body);
        for (const destructured of extractDestructuredKeys(body)) {
          references.push(
            buildReference(
              filePath,
              scanContent,
              newlineIndices,
              bodyOffset + destructured.relativeIndex,
              destructured.key,
              pattern.syntax,
            ),
          );
        }
      }
    }
  }

  // Project-supplied escape-hatch patterns run on every scanned file, whatever its
  // language. They get comments masked but string bodies intact: the built-ins only
  // ever capture bare identifiers, but a custom pattern's key often isn't one
  // (`cfg.get('app.db.url')`), and the default masking would blank it.
  if (applicablePatterns.length) {
    references.push(...matchExtraPatterns(
      filePath,
      maskCommentsPreserveLayout(rawContent, language, { maskStringBodies: false }),
      applicablePatterns,
      newlineIndices,
    ));
  }

  return references;
}


async function scanFilesWithLimit<T, R>(
  items: Array<T>,
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<Array<R>> {
  if (items.length === 0) return [];
  const results: Array<R> = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex++;
      if (currentIndex >= items.length) return;
      results[currentIndex] = await worker(items[currentIndex]);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    await runWorker();
  });
  await Promise.all(workers);
  return results;
}

/** A custom pattern prepared for matching: global regex + resolved extension scope. */
interface NormalizedExtraPattern {
  regex: RegExp;
  /** `null` means "every file the built-in discovery picks up". */
  extensions: Set<string> | null;
}

/**
 * Normalize a user-supplied extension to the lowercase dotted form `path.extname()`
 * returns, so `tf`, `.tf` and `.TF` all mean the same thing.
 */
function normalizeExtension(raw: string): string | undefined {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return undefined;
  return trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
}

function normalizeExtraPatterns(
  input: Array<RegExp | ExtraScanPattern> | undefined,
): Array<NormalizedExtraPattern> {
  const normalized: Array<NormalizedExtraPattern> = [];
  for (const entry of input ?? []) {
    const pattern = entry instanceof RegExp ? entry : entry.pattern;
    // `matchAll` requires the global flag, and a non-global pattern is what a user
    // writing `/.../ ` naturally produces.
    const regex = pattern.global ? pattern : new RegExp(pattern.source, `${pattern.flags}g`);

    const rawFileTypes = entry instanceof RegExp ? undefined : entry.fileTypes;
    const extensions = new Set<string>();
    for (const raw of rawFileTypes ?? []) {
      const ext = normalizeExtension(raw);
      if (ext) extensions.add(ext);
    }
    normalized.push({ regex, extensions: extensions.size ? extensions : null });
  }
  return normalized;
}

/**
 * Extensions that are only in the scan because some pattern asked for them. The
 * built-in discovery would skip these files entirely, and no built-in pattern applies
 * to them once they're read.
 */
function collectWidenedExtensions(patterns: Array<NormalizedExtraPattern>): Set<string> {
  const widened = new Set<string>();
  for (const { extensions } of patterns) {
    for (const ext of extensions ?? []) {
      if (!(ext in LANGUAGE_BY_EXTENSION)) widened.add(ext);
    }
  }
  return widened;
}

export async function scanCodeForEnvVars(
  options: ScanCodeEnvVarsOptions = {},
  additionalExcludeDirs: Array<string> = [],
): Promise<ScanCodeEnvVarsResult> {
  const cwd = options.cwd || process.cwd();
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const maxFileSizeBytes = options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;
  const excludeDirs = new Set([
    ...DEFAULT_IGNORED_DIRS,
    ...(options.ignoredDirs ?? []),
    ...additionalExcludeDirs,
  ]);

  const extraPatterns = normalizeExtraPatterns(options.extraPatterns);
  const widenedExtensions = collectWidenedExtensions(extraPatterns);

  const filePaths = await discoverSourceFiles(cwd, excludeDirs, widenedExtensions);
  const references = await scanFilesWithLimit(filePaths, concurrency, async (filePath) => {
    return scanFileForEnvVarReferences(filePath, maxFileSizeBytes, extraPatterns);
  });

  const flattenedReferences = references.flat();
  const uniqueKeys = [...new Set(flattenedReferences.map((r) => r.key))].sort((a, b) => a.localeCompare(b));

  return {
    keys: uniqueKeys,
    references: flattenedReferences,
    scannedFilesCount: filePaths.length,
  };
}
