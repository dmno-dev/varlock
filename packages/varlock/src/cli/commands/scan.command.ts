import path from 'node:path';
import fs from 'node:fs/promises';
import { define } from 'gunshi';
import ansis from 'ansis';
import { gracefulExit } from 'exit-hook';
import _ from '@env-spec/utils/my-dash';

import { spawnAsync } from '@env-spec/utils/exec-helpers';
import { pathExists } from '@env-spec/utils/fs-utils';
import { redactString } from '../../runtime/lib/redaction';
import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';
import { CliExitError } from '../helpers/exit-error';
import { fmt, logLines } from '../helpers/pretty-format';
import { detectJsPackageManager } from '../helpers/js-package-manager-utils';
import { isBundledSEA } from '../helpers/install-detection';
import { loadVarlockEnvGraph } from '../../lib/load-graph';

// Directories to always skip when walking the file tree
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.nuxt',
  'vendor',
  '.venv',
  'venv',
  '__pycache__',
  '.turbo',
  'coverage',
]);

// File extensions that are binary and should be skipped
const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.ico',
  '.mp3',
  '.mp4',
  '.wav',
  '.avi',
  '.mov',
  '.zip',
  '.tar',
  '.gz',
  '.rar',
  '.7z',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.pyc',
  '.class',
  '.o',
]);

export const commandSpec = define({
  name: 'scan',
  description: 'Scan files for sensitive config values that should not be in plaintext',
  args: {
    staged: {
      type: 'boolean',
      description: 'Only scan staged git files',
    },
    'include-ignored': {
      type: 'boolean',
      description: 'Include git-ignored files in the scan',
    },
    'install-hook': {
      type: 'boolean',
      description: 'Set up varlock scan as a git pre-commit hook',
    },
    path: {
      type: 'string',
      short: 'p',
      description: 'Path to a specific .env file (e.g. .env.prod) or directory ending with "/" to use as the schema entry point (default: current directory)',
    },
  },
  examples: `
Loads your varlock config, resolves all sensitive values, then scans files to
ensure none of those sensitive values appear in plaintext.

Examples:
  varlock scan                    # Scan non-git-ignored files in current directory
  varlock scan --staged           # Only scan staged git files
  varlock scan --include-ignored  # Scan all files, including git-ignored ones
  varlock scan --path .env.prod   # Use a specific .env file as the schema entry point
  varlock scan --install-hook     # Set up as a git pre-commit hook
  `.trim(),
});

export interface ScanFinding {
  filePath: string;
  lineNumber: number;
  columnNumber: number;
  line: string;
  sensitiveKeyName: string;
  sensitiveValue: string;
}

export async function getGitFiles(cwd: string, onlyStaged: boolean): Promise<Array<string> | null> {
  try {
    let output: string;
    if (onlyStaged) {
      output = await spawnAsync(
        'git',
        ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'],
        { cwd },
      );
    } else {
      output = await spawnAsync(
        'git',
        ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
        { cwd },
      );
    }
    return output.split('\0').filter(Boolean)
      .filter((f) => !BINARY_EXTENSIONS.has(path.extname(f).toLowerCase()))
      .map((f) => path.resolve(cwd, f));
  } catch {
    return null;
  }
}

export async function walkDirectory(dir: string): Promise<Array<string>> {
  const files: Array<string> = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      files.push(...await walkDirectory(fullPath));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (BINARY_EXTENSIONS.has(ext)) continue;
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Scans a single file for occurrences of any of the provided sensitive values.
 * sensitiveValues is a map from env key name to its resolved string value.
 */
export async function scanFileForValues(
  filePath: string,
  sensitiveValues: Map<string, string>,
): Promise<Array<ScanFinding>> {
  const findings: Array<ScanFinding> = [];
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch {
    return findings;
  }

  // Skip binary files (contain null bytes)
  if (content.includes('\0')) return findings;

  // Quick pre-check: skip the file entirely if none of the values appear
  let anyMatch = false;
  for (const val of sensitiveValues.values()) {
    if (content.includes(val)) {
      anyMatch = true;
      break;
    }
  }
  if (!anyMatch) return findings;

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const [keyName, val] of sensitiveValues) {
      const colIdx = line.indexOf(val);
      if (colIdx !== -1) {
        findings.push({
          filePath,
          lineNumber: i + 1,
          columnNumber: colIdx + 1,
          line: line.trim(),
          sensitiveKeyName: keyName,
          sensitiveValue: val,
        });
        break; // one finding per line is enough
      }
    }
  }
  return findings;
}

const SCAN_COMMAND = 'varlock scan';

/**
 * Determines the correct command to use in a git hook script.
 * If varlock is installed as a standalone binary, uses `varlock` directly.
 * Otherwise, prefixes with the detected JS package manager's exec command.
 */
function getHookCommand(): string {
  if (isBundledSEA()) return SCAN_COMMAND;
  const pm = detectJsPackageManager();
  if (pm) return `${pm.exec} ${SCAN_COMMAND}`;
  // fallback - assume varlock is available on PATH
  return SCAN_COMMAND;
}

type HookManagerKind = 'husky' | 'lefthook' | 'simple-git-hooks';

async function detectHookManager(cwd: string): Promise<HookManagerKind | null> {
  // Check for husky
  if (await pathExists(path.join(cwd, '.husky'))) return 'husky';

  // Check for lefthook config files
  const lefthookFiles = ['lefthook.yml', 'lefthook.yaml', '.lefthook.yml', '.lefthook.yaml'];
  for (const file of lefthookFiles) {
    if (await pathExists(path.join(cwd, file))) return 'lefthook';
  }

  // Check for simple-git-hooks in package.json
  const pkgJsonPath = path.join(cwd, 'package.json');
  if (await pathExists(pkgJsonPath)) {
    try {
      const pkgJson = JSON.parse(await fs.readFile(pkgJsonPath, 'utf-8'));
      if (pkgJson['simple-git-hooks']) return 'simple-git-hooks';
    } catch { /* ignore parse errors */ }
  }

  return null;
}

async function findGitRoot(cwd: string): Promise<string | null> {
  try {
    const root = await spawnAsync('git', ['rev-parse', '--show-toplevel'], { cwd });
    return root.trim();
  } catch {
    return null;
  }
}

async function installHook(cwd: string): Promise<void> {
  const gitRoot = await findGitRoot(cwd);
  if (!gitRoot) {
    throw new CliExitError('Not inside a git repository', {
      suggestion: 'Run `git init` first, or make sure you are inside a git repository.',
    });
  }

  const hookCommand = getHookCommand();
  const hookScript = `#!/bin/sh\n${hookCommand}\n`;
  const hookManager = await detectHookManager(gitRoot);

  if (hookManager === 'husky') {
    logLines([
      '',
      `Detected ${ansis.bold('husky')} as your git hook manager.`,
      '',
      `Add ${ansis.bold(hookCommand)} to your pre-commit hook:`,
      '',
      ansis.dim(`  echo "${hookCommand}" >> .husky/pre-commit`),
      '',
      `Or if creating a new hook:`,
      '',
      ansis.dim(`  echo "${hookCommand}" > .husky/pre-commit`),
      '',
    ]);
    return;
  }

  if (hookManager === 'lefthook') {
    logLines([
      '',
      `Detected ${ansis.bold('lefthook')} as your git hook manager.`,
      '',
      'Add the following to your lefthook config:',
      '',
      ansis.dim('  pre-commit:'),
      ansis.dim('    commands:'),
      ansis.dim('      varlock-scan:'),
      ansis.dim(`        run: ${hookCommand}`),
      '',
    ]);
    return;
  }

  if (hookManager === 'simple-git-hooks') {
    logLines([
      '',
      `Detected ${ansis.bold('simple-git-hooks')} in your package.json.`,
      '',
      'Add the following to your package.json:',
      '',
      ansis.dim('  "simple-git-hooks": {'),
      ansis.dim(`    "pre-commit": "${hookCommand}"`),
      ansis.dim('  }'),
      '',
      `Then run ${ansis.dim('npx simple-git-hooks')} to update the hooks.`,
      '',
    ]);
    return;
  }

  // No hook manager detected -- install directly to .git/hooks/pre-commit
  const hooksDir = path.join(gitRoot, '.git', 'hooks');
  const hookPath = path.join(hooksDir, 'pre-commit');

  // Ensure hooks directory exists
  await fs.mkdir(hooksDir, { recursive: true });

  // Check if a pre-commit hook already exists
  if (await pathExists(hookPath)) {
    const existingContent = await fs.readFile(hookPath, 'utf-8');
    if (existingContent.includes(SCAN_COMMAND)) {
      logLines([
        '',
        ansis.green(`The pre-commit hook already includes ${ansis.bold(SCAN_COMMAND)} - nothing to do!`),
        '',
      ]);
      return;
    }
    // Append to existing hook
    const updatedContent = existingContent.trimEnd() + `\n${hookCommand}\n`;
    await fs.writeFile(hookPath, updatedContent);
    await fs.chmod(hookPath, 0o755);
    logLines([
      '',
      ansis.green(`Added ${ansis.bold(hookCommand)} to existing pre-commit hook.`),
      fmt.filePath(hookPath),
      '',
    ]);
    return;
  }

  // Create new hook
  await fs.writeFile(hookPath, hookScript);
  await fs.chmod(hookPath, 0o755);
  logLines([
    '',
    ansis.green(`Created pre-commit hook at ${fmt.filePath(hookPath)}`),
    ansis.dim('Your staged files will now be scanned for sensitive values before each commit.'),
    '',
  ]);
}

export const commandFn: TypedGunshiCommandFn<typeof commandSpec> = async (ctx) => {
  // Handle --install-hook before doing any scanning
  if (ctx.values['install-hook']) {
    await installHook(process.cwd());
    return;
  }

  const onlyStaged = ctx.values.staged ?? false;
  const includeIgnored = ctx.values['include-ignored'] ?? false;

  // Load the varlock env graph to get the actual sensitive values
  const envGraph = await loadVarlockEnvGraph({
    entryFilePath: ctx.values.path,
  });

  // Check for loading/schema errors
  for (const source of envGraph.sortedDataSources) {
    if (source.loadingError) {
      throw new CliExitError(`Error loading config: ${source.loadingError.message}`, {
        suggestion: 'Make sure your .env.schema file is valid.',
      });
    }
  }

  await envGraph.resolveEnvValues();

  // Collect all sensitive string values that are non-empty
  const sensitiveValues = new Map<string, string>();
  for (const itemKey in envGraph.configSchema) {
    const item = envGraph.configSchema[itemKey];
    if (item.isSensitive && _.isString(item.resolvedValue) && item.resolvedValue !== '') {
      sensitiveValues.set(itemKey, item.resolvedValue);
    }
  }

  if (sensitiveValues.size === 0) {
    logLines([ansis.green('✅ No sensitive values found in config - nothing to scan for.')]);
    return;
  }

  const cwd = process.cwd();
  let files: Array<string>;

  if (includeIgnored) {
    // Walk the full directory tree, no git filtering
    files = await walkDirectory(cwd);
  } else {
    // Try to use git to get non-ignored files
    const gitFiles = await getGitFiles(cwd, onlyStaged);
    if (gitFiles !== null) {
      files = gitFiles;
    } else {
      // Git not available - fall back to walking directory
      if (onlyStaged) {
        throw new CliExitError('Could not run git to find staged files', {
          suggestion: 'Make sure git is installed and you are inside a git repository.',
        });
      }
      files = await walkDirectory(cwd);
    }
  }

  if (files.length === 0) {
    if (onlyStaged) {
      console.log('No staged files to scan.');
    } else {
      console.log(ansis.green('✅ No files found to scan.'));
    }
    return;
  }

  const allFindings: Array<ScanFinding> = [];
  for (const filePath of files) {
    const findings = await scanFileForValues(filePath, sensitiveValues);
    allFindings.push(...findings);
  }

  if (allFindings.length === 0) {
    logLines([ansis.green(`✅ No sensitive values found in plaintext. (scanned ${files.length} file${files.length === 1 ? '' : 's'})`)]);
    return;
  }

  // Group findings by file for display
  const findingsByFile = new Map<string, Array<ScanFinding>>();
  for (const finding of allFindings) {
    const existing = findingsByFile.get(finding.filePath) ?? [];
    existing.push(finding);
    findingsByFile.set(finding.filePath, existing);
  }

  console.error(ansis.red(`\n🚨 Found ${allFindings.length} sensitive value(s) in plaintext across ${findingsByFile.size} file(s):\n`));
  for (const [filePath, findings] of findingsByFile) {
    const relPath = path.relative(cwd, filePath);
    for (const finding of findings) {
      // Redact the actual secret value in the displayed line
      const redactedLine = finding.line.replaceAll(finding.sensitiveValue, redactString(finding.sensitiveValue)!);
      const truncatedLine = redactedLine.length > 100
        ? `${redactedLine.substring(0, 100)}…`
        : redactedLine;
      console.error(`  ${fmt.fileName(`${relPath}:${finding.lineNumber}:${finding.columnNumber}`)} ${ansis.yellow(finding.sensitiveKeyName)}`);
      console.error(`    ${ansis.dim(truncatedLine)}`);
    }
    console.error('');
  }

  gracefulExit(1);
};
