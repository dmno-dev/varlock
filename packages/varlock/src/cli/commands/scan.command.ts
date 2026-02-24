import path from 'node:path';
import fs from 'node:fs/promises';
import { define } from 'gunshi';
import ansis from 'ansis';
import { gracefulExit } from 'exit-hook';

import { spawnAsync } from '@env-spec/utils/exec-helpers';
import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';
import { CliExitError } from '../helpers/exit-error';
import { fmt, logLines } from '../helpers/pretty-format';

interface SecretPattern {
  id: string;
  description: string;
  pattern: RegExp;
}

// Well-known secret patterns with low false positive rates
export const SECRET_PATTERNS: Array<SecretPattern> = [
  {
    id: 'pem-private-key',
    description: 'PEM Private Key',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
  },
  {
    id: 'aws-access-key-id',
    description: 'AWS Access Key ID',
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
  },
  {
    id: 'github-token',
    description: 'GitHub Token',
    pattern: /\bgh[pors]_[A-Za-z0-9_]{36,255}\b/,
  },
  {
    id: 'github-fine-grained-pat',
    description: 'GitHub Fine-Grained Personal Access Token',
    pattern: /\bgithub_pat_[A-Za-z0-9_]{82}\b/,
  },
  {
    id: 'slack-token',
    description: 'Slack Token',
    pattern: /\bxox[baprs]-[0-9A-Za-z]{10,48}\b/,
  },
  {
    id: 'url-with-credentials',
    description: 'URL with embedded credentials',
    pattern: /https?:\/\/[^:@]+:[^@]{8,}@[^/\s]+/,
  },
];

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
  description: 'Scan files for plaintext secrets',
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
      description: 'Path to scan (default: current directory)',
    },
  },
  examples: `
Scans files for plaintext secrets that should not be committed to git.
By default, git-ignored files are excluded from the scan.

Examples:
  varlock scan                    # Scan current directory (skip git-ignored files)
  varlock scan --staged           # Only scan staged files (useful as a pre-commit hook)
  varlock scan --include-ignored  # Scan all files, including git-ignored ones
  varlock scan --path ./src       # Scan a specific directory

Git hook setup (add to .git/hooks/pre-commit):
  #!/bin/sh
  varlock scan --staged
  `.trim(),
});

interface ScanFinding {
  filePath: string;
  lineNumber: number;
  line: string;
  patternId: string;
  patternDescription: string;
}

async function getGitFiles(cwd: string, onlyStaged: boolean): Promise<Array<string> | null> {
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

async function walkDirectory(dir: string): Promise<Array<string>> {
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

export async function scanFile(filePath: string): Promise<Array<ScanFinding>> {
  const findings: Array<ScanFinding> = [];
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch {
    return findings;
  }

  // Skip binary files (contain null bytes)
  if (content.includes('\0')) return findings;

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const secretPattern of SECRET_PATTERNS) {
      if (secretPattern.pattern.test(line)) {
        findings.push({
          filePath,
          lineNumber: i + 1,
          line: line.trim(),
          patternId: secretPattern.id,
          patternDescription: secretPattern.description,
        });
        break; // one finding per line is enough
      }
    }
  }
  return findings;
}

export const commandFn: TypedGunshiCommandFn<typeof commandSpec> = async (ctx) => {
  const cwd = path.resolve(ctx.values.path || process.cwd());
  const onlyStaged = ctx.values.staged ?? false;
  const includeIgnored = ctx.values['include-ignored'] ?? false;

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
    const findings = await scanFile(filePath);
    allFindings.push(...findings);
  }

  if (allFindings.length === 0) {
    logLines([ansis.green(`✅ No secrets detected. (scanned ${files.length} file${files.length === 1 ? '' : 's'})`)]);
    return;
  }

  // Group findings by file for display
  const findingsByFile = new Map<string, Array<ScanFinding>>();
  for (const finding of allFindings) {
    const existing = findingsByFile.get(finding.filePath) ?? [];
    existing.push(finding);
    findingsByFile.set(finding.filePath, existing);
  }

  console.error(ansis.red(`\n🚨 Found ${allFindings.length} potential secret(s) in ${findingsByFile.size} file(s):\n`));
  for (const [filePath, findings] of findingsByFile) {
    const relPath = path.relative(cwd, filePath);
    console.error(fmt.filePath(relPath));
    for (const finding of findings) {
      const truncatedLine = finding.line.length > 100
        ? `${finding.line.substring(0, 100)}…`
        : finding.line;
      console.error(`  Line ${finding.lineNumber}: ${ansis.yellow(finding.patternDescription)}`);
      console.error(`    ${ansis.dim(truncatedLine)}`);
    }
    console.error('');
  }

  gracefulExit(1);
};
