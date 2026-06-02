#!/usr/bin/env node
// Pin extension.toml's grammar entry to the current git commit.
//
// Workflow:
//   1. Commit grammar changes.
//   2. Run: node packages/zed-plugin/scripts/pin-grammar.mjs
//   3. Commit the extension.toml update.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = 'https://github.com/dmno-dev/varlock';
const GRAMMAR_PATH = 'packages/zed-plugin/tree-sitter-varlock-schema';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const extensionTomlPath = join(root, 'packages', 'zed-plugin', 'extension.toml');

function runGit(args) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`git ${args.join(' ')} failed${output ? `:\n${output}` : ''}`);
  }

  return result.stdout.trim();
}

const grammarCommit = runGit(['rev-parse', 'HEAD']);
const dirtyGrammar = runGit(['status', '--porcelain', '--', GRAMMAR_PATH]);
if (dirtyGrammar) {
  throw new Error(`commit ${GRAMMAR_PATH}/ changes before pinning the grammar:\n${dirtyGrammar}`);
}
runGit(['cat-file', '-e', `${grammarCommit}:${GRAMMAR_PATH}/src/parser.c`]);

const extensionToml = readFileSync(extensionTomlPath, 'utf8');
const updated = extensionToml.replace(
  /\[grammars\.env\]\n(?:.+\n)+?(?=\n\[|$)/,
  `[grammars.env]\nrepository = "${REPO}"\nrev = "${grammarCommit}"\npath = "${GRAMMAR_PATH}"\n`,
);

if (updated === extensionToml) {
  throw new Error('failed to find [grammars.env] block in extension.toml');
}

writeFileSync(extensionTomlPath, updated);
console.log(`Pinned env grammar to ${grammarCommit}`);
