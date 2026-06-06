import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { generateTmLanguage } from 'monogram/src/gen-tm';
import { generateTreeSitter } from 'monogram/src/gen-treesitter';
import { envSpecGrammar } from '../src/monogram/env-spec-grammar';

function writeFile(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content.endsWith('\n') ? content : `${content}\n`);
}

const currentDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(currentDir, '../../..');
const vscodeLanguageDir = join(repoRoot, 'packages/vscode-plugin/language');
const treeSitterDir = join(repoRoot, 'packages/env-spec-parser/tree-sitter/env-spec');

const tm = generateTmLanguage(envSpecGrammar, 'env-spec');
const tmOutPath = join(vscodeLanguageDir, 'env-spec.tmLanguage.monogram.json');
writeFile(tmOutPath, JSON.stringify(tm, null, 2));

const treeSitter = generateTreeSitter(envSpecGrammar, 'env-spec');
writeFile(join(treeSitterDir, 'grammar.js'), treeSitter.grammarJs);
writeFile(join(treeSitterDir, 'queries/highlights.scm'), treeSitter.highlightsScm);
if (treeSitter.scannerC.trim()) {
  writeFile(join(treeSitterDir, 'src/scanner.c'), treeSitter.scannerC);
}

writeFile(
  join(treeSitterDir, 'package.json'),
  JSON.stringify({
    name: 'tree-sitter-env-spec',
    version: '0.0.0',
    private: true,
  }, null, 2),
);

// eslint-disable-next-line no-console
console.log(`Generated ${tmOutPath}`);
// eslint-disable-next-line no-console
console.log(`Generated ${treeSitterDir}`);
