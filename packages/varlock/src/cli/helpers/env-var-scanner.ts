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

export interface ScanCodeEnvVarsOptions {
  cwd?: string;
  concurrency?: number;
  maxFileSizeBytes?: number;
  // legacy option, treated as additional excludes
  ignoredDirs?: Array<string>;
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

async function discoverSourceFiles(cwd: string, ignoredDirs: Set<string>): Promise<Array<string>> {
  const filePaths: Array<string> = [];
  const globExcludes = [...ignoredDirs].flatMap((dirName) => [`**/${dirName}`, `**/${dirName}/**`]);

  for await (const relativePath of fs.glob('**/*', { cwd, exclude: globExcludes })) {
    const normalizedRelativePath = String(relativePath).replaceAll('\\', '/');

    const extension = path.extname(normalizedRelativePath).toLowerCase();
    if (!(extension in LANGUAGE_BY_EXTENSION)) continue;

    filePaths.push(path.resolve(cwd, normalizedRelativePath));
  }
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
        if (chars[i] === '\\') {
          i += 2;
          continue;
        }
        if (chars[i] === '{') depth++;
        else if (chars[i] === '}') depth--;
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

        if (exprCh === '/' && exprNext === '/') {
          i += 2;
          while (i < chars.length && chars[i] !== '\n') i++;
          continue;
        }
        if (exprCh === '/' && exprNext === '*') {
          i += 2;
          while (i < chars.length) {
            if (chars[i] === '*' && chars[i + 1] === '/') {
              i += 2;
              break;
            }
            i++;
          }
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

function maskCommentsPreserveLayout(content: string, language: ScannerLanguage): string {
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
      i = skipAndMaskQuotedString(chars, i, '\'');
      continue;
    }
    if (ch === '"') {
      i = skipAndMaskQuotedString(chars, i, '"');
      continue;
    }
    if (ch === '`' && (language === 'js-like' || language === 'go')) {
      i = skipAndMaskTemplateLiteral(chars, i);
      continue;
    }

    i++;
  }

  return chars.join('');
}

async function scanFileForEnvVarReferences(
  filePath: string,
  maxFileSizeBytes: number,
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
  if (!language) return [];

  const scanContent = maskCommentsPreserveLayout(rawContent, language);
  const newlineIndices = getNewlineIndices(scanContent);
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

  const filePaths = await discoverSourceFiles(cwd, excludeDirs);
  const references = await scanFilesWithLimit(filePaths, concurrency, async (filePath) => {
    return scanFileForEnvVarReferences(filePath, maxFileSizeBytes);
  });

  const flattenedReferences = references.flat();
  const uniqueKeys = [...new Set(flattenedReferences.map((r) => r.key))].sort((a, b) => a.localeCompare(b));

  return {
    keys: uniqueKeys,
    references: flattenedReferences,
    scannedFilesCount: filePaths.length,
  };
}
