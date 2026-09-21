import fs from 'node:fs/promises';
import os from 'node:os';
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
  /**
   * Directories to exclude, in the same two forms as `additionalExcludeDirs`: a bare
   * name matches at any depth, an entry with a separator (or rooted with `/` or `./`)
   * is anchored at the scan root. Legacy option, treated as additional excludes.
   */
  ignoredDirs?: Array<string>;
  /**
   * Project-supplied patterns (e.g. from the `@auditExtraPatterns` root
   * decorator), run after the built-in patterns. The first capture group is
   * the env key; patterns without one match nothing. The global flag is
   * added when missing.
   *
   * Like the built-ins these skip commented-out lines, and a capture that
   * isn't a bare env-key identifier (`cfg.get('app.db.url')`) still matches.
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
  exclusions: DirExclusions,
  widenedExtensions: Set<string>,
): Promise<Array<string>> {
  const filePaths: Array<string> = [];

  async function walk(dir: string, isRoot: boolean, relativeDir: string): Promise<void> {
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
        if (exclusions.names.has(entry.name)) continue;
        // posix-joined regardless of platform, so schema entries stay portable
        const entryRelativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
        if (exclusions.paths.has(entryRelativePath)) continue;
        subdirWalks.push(walk(path.join(dir, entry.name), false, entryRelativePath));
      } else if (entry.isFile()) {
        const extension = path.extname(entry.name).toLowerCase();
        if (!(extension in LANGUAGE_BY_EXTENSION) && !widenedExtensions.has(extension)) continue;
        filePaths.push(path.join(dir, entry.name));
      }
    }
    await Promise.all(subdirWalks);
  }

  await walk(cwd, true, '');
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
 * Blank every line that is entirely a comment, preserving byte offsets (and therefore
 * line/column) by replacing the line's characters with spaces.
 *
 * This is deliberately line-based rather than a lexer. The scanner used to lex strings,
 * templates and comments so it could also mask string bodies, but a hand-rolled lexer
 * over ten languages has too many ways to fall out of sync (a quote inside a regex
 * literal, JSX text, a docstring with an apostrophe), and when it did, every reference
 * after that point silently vanished. A whole-line rule can't cascade: the worst case is
 * one extra reported reference, which is visible and easy to suppress.
 *
 * Trailing comments (`foo(); // process.env.X`) and mentions inside string literals are
 * therefore scanned like any other code.
 */
function maskCommentLines(content: string, language: ScannerLanguage): string {
  const supportsHashComments = language === 'python' || language === 'ruby' || language === 'php';
  const supportsSlashComments = language !== 'python' && language !== 'ruby';

  // Returns how many leading characters of the line are comment, or 0 for a code line.
  const commentPrefixLength = (line: string): number => {
    const trimmed = line.trimStart();
    if (supportsHashComments && trimmed.startsWith('#')) return line.length;
    if (!supportsSlashComments) return 0;
    if (trimmed.startsWith('//')) return line.length;
    // a block comment start, or the interior / closing lines of a `/** ... */` block. A
    // `*` followed by anything else (`*count += 1` in rust) is code.
    if (trimmed.startsWith('/*') || /^\*(?:[\s/]|$)/.test(trimmed)) {
      // `/* generated */ const key = process.env.X;` is code after the closing delimiter
      const closeIndex = line.indexOf('*/');
      return closeIndex === -1 ? line.length : closeIndex + 2;
    }
    return 0;
  };

  return content
    .split('\n')
    .map((line) => {
      const maskedLength = commentPrefixLength(line);
      return maskedLength ? ' '.repeat(maskedLength) + line.slice(maskedLength) : line;
    })
    .join('\n');
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

  // Masking preserves byte offsets, so the raw file's newline positions still give the
  // right line/column for every match.
  const scanContent = maskCommentLines(rawContent, language);
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
  // language, over the same comment-masked content.
  if (applicablePatterns.length) {
    references.push(...matchExtraPatterns(filePath, scanContent, applicablePatterns, newlineIndices));
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
 * A directory exclusion, resolved into the two things the walk can match on.
 *
 * `names` match any directory with that name wherever it appears (`node_modules`,
 * `fixtures`). `paths` are scan-root-relative with posix separators, matching one
 * directory only.
 */
export interface DirExclusions {
  names: Set<string>;
  paths: Set<string>;
  /**
   * Every path entry as an absolute path. Callers that scan several roots forward these
   * instead of the raw entries, so a `./`-relative entry keeps meaning the same
   * directory rather than being re-resolved against each root.
   */
  absolute: Array<string>;
  /**
   * Entries that look like paths but don't say so (`apps/docs` rather than
   * `./apps/docs`). Read as paths here so a direct library caller gets the sane
   * behavior, while the CLI rejects them rather than guessing.
   */
  unrooted: Array<string>;
  /**
   * Entries that resolved outside the scanned tree, so they can never match. Ignored
   * here, since a caller scanning several roots will have entries that apply to one of
   * them and not the others; the CLI rejects entries outside the project root entirely.
   */
  outside: Array<string>;
  /**
   * Path entries that resolved to something that exists but isn't a directory. Only
   * directories can be pruned from the walk, so these would exclude nothing. A path
   * that doesn't exist at all is fine and simply never matches, since a schema is
   * shared across branches and checkouts.
   */
  notDirectories: Array<string>;
}

/** realpath, falling back to the input when the path doesn't exist yet. */
async function realpathOrSelf(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch {
    return target;
  }
}

/**
 * Split raw exclusion entries into name and path matchers.
 *
 * A bare name matches at any depth. Anything path-shaped must say so, using the same
 * prefixes as `@import`: `./` or `../` relative to the scan root, `~/` for home, or an
 * absolute path. Trailing separators are ignored and `\` works as a separator, so
 * Windows-style entries are fine.
 *
 * Containment is tested against both the given scan root and its realpath, since a
 * project reached through a symlink (`/tmp` on macOS, a linked workspace) spells the
 * same directory two ways and a purely textual compare would call a valid entry
 * outside the tree.
 *
 * This is the single normalizer for both `@auditIgnorePaths()` and `--ignore`, so the
 * two can't drift apart.
 */
export async function normalizeDirExclusions(
  entries: Iterable<string>,
  scanRoot: string,
): Promise<DirExclusions> {
  const names = new Set<string>();
  const paths = new Set<string>();
  const absolute: Array<string> = [];
  const unrooted: Array<string> = [];
  const outside: Array<string> = [];
  const notDirectories: Array<string> = [];

  const rawRoot = path.resolve(scanRoot);
  const realRoot = await realpathOrSelf(rawRoot);

  const containedRelative = (candidate: string, root: string): string | undefined => {
    const relative = path.relative(root, candidate);
    // `..` alone or a `../` segment means outside. A bare startsWith('..') would also
    // catch legitimate names like `..cache`, which are inside the tree.
    if (relative === '..' || relative.startsWith(`..${path.sep}`)) return undefined;
    if (path.isAbsolute(relative)) return undefined;
    return relative;
  };

  const addResolved = async (absolutePath: string, original: string) => {
    absolute.push(absolutePath);
    const realCandidate = await realpathOrSelf(absolutePath);
    const relative = containedRelative(absolutePath, rawRoot)
      ?? containedRelative(realCandidate, realRoot)
      ?? containedRelative(realCandidate, rawRoot)
      ?? containedRelative(absolutePath, realRoot);
    if (relative === undefined) {
      outside.push(original);
      return;
    }
    // empty means the scan root itself, which isn't excludable
    if (!relative) return;

    try {
      if (!(await fs.stat(realCandidate)).isDirectory()) {
        notDirectories.push(original);
        return;
      }
    } catch {
      // doesn't exist: allowed, just won't match anything
    }

    paths.add(relative.split(path.sep).join('/'));
  };

  for (const raw of entries) {
    const trimmed = raw.trim().replace(/[\\/]+$/, '');
    if (!trimmed) continue;
    const unixed = trimmed.replace(/\\/g, '/');

    if (unixed === '~' || unixed.startsWith('~/')) {
      await addResolved(path.join(os.homedir(), unixed.slice(1)), trimmed);
    } else if (path.isAbsolute(trimmed)) {
      await addResolved(path.resolve(trimmed), trimmed);
    } else if (unixed === '.' || unixed.startsWith('./') || unixed.startsWith('../')) {
      await addResolved(path.resolve(rawRoot, unixed), trimmed);
    } else if (unixed.includes('/')) {
      unrooted.push(trimmed);
      await addResolved(path.resolve(rawRoot, unixed), trimmed);
    } else {
      names.add(unixed);
    }
  }

  return {
    names, paths, absolute, unrooted, outside, notDirectories,
  };
}

/**
 * Whether a directory would be skipped by these exclusions, given its path relative to
 * the scan root the exclusions were built against (posix separators, no leading `./`).
 *
 * An ancestor being excluded counts, since the walk never descends into it. The walk
 * itself gets this for free by testing each entry as it descends; this is for callers
 * that need to ask about a path up front.
 */
export function isDirExcluded(relativePath: string, exclusions: DirExclusions): boolean {
  const segments = relativePath.split('/').filter((segment) => segment && segment !== '.');
  if (!segments.length) return false;

  for (const segment of segments) {
    if (exclusions.names.has(segment)) return true;
  }
  for (let i = 1; i <= segments.length; i++) {
    if (exclusions.paths.has(segments.slice(0, i).join('/'))) return true;
  }
  return false;
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
  const exclusions = await normalizeDirExclusions([
    ...DEFAULT_IGNORED_DIRS,
    ...(options.ignoredDirs ?? []),
    ...additionalExcludeDirs,
  ], cwd);

  const extraPatterns = normalizeExtraPatterns(options.extraPatterns);
  const widenedExtensions = collectWidenedExtensions(extraPatterns);

  const filePaths = await discoverSourceFiles(cwd, exclusions, widenedExtensions);
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
