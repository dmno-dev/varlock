import path from 'node:path';
import fs from 'node:fs/promises';
import { define } from 'gunshi';
import ansis from 'ansis';
import { gracefulExit } from 'exit-hook';
import _ from '@env-spec/utils/my-dash';

import { spawnAsync } from '@env-spec/utils/exec-helpers';
import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';
import { CliExitError } from '../helpers/exit-error';
import { fmt, logLines } from '../helpers/pretty-format';
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
      description: 'Only scan staged git files (useful as a pre-commit hook)',
    },
    'include-ignored': {
      type: 'boolean',
      description: 'Include git-ignored files in the scan',
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
  varlock scan --staged           # Only scan staged files (useful as a pre-commit hook)
  varlock scan --include-ignored  # Scan all files, including git-ignored ones
  varlock scan --path .env.prod   # Use a specific .env file as the schema entry point

Git hook setup (add to .git/hooks/pre-commit):
  #!/bin/sh
  varlock scan --staged
  `.trim(),
});

export interface ScanFinding {
  filePath: string;
  lineNumber: number;
  line: string;
  sensitiveKeyName: string;
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
    return output.split('\0').filter(Boolean).map((f) => path.resolve(cwd, f));
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
      if (line.includes(val)) {
        findings.push({
          filePath,
          lineNumber: i + 1,
          line: line.trim(),
          sensitiveKeyName: keyName,
        });
        break; // one finding per line is enough
      }
    }
  }
  return findings;
}

export const commandFn: TypedGunshiCommandFn<typeof commandSpec> = async (ctx) => {
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
    console.error(fmt.filePath(relPath));
    for (const finding of findings) {
      const truncatedLine = finding.line.length > 100
        ? `${finding.line.substring(0, 100)}…`
        : finding.line;
      console.error(`  Line ${finding.lineNumber}: ${ansis.yellow(finding.sensitiveKeyName)}`);
      console.error(`    ${ansis.dim(truncatedLine)}`);
    }
    console.error('');
  }

  gracefulExit(1);
};
