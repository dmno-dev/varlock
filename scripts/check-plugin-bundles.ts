/**
 * Checks that every built plugin in packages/plugins is a single JS file.
 *
 * varlock runs a plugin's entry file itself (not via require), so a split chunk
 * that requires the entry back re-runs it outside of the plugin context (#1113).
 * Plugin tsdown configs set `codeSplitting: false`; this catches regressions.
 *
 * Usage (after building):
 *   bun run scripts/check-plugin-bundles.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MONOREPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGINS_DIR = path.join(MONOREPO_ROOT, 'packages/plugins');

const problems: Array<string> = [];
let checkedCount = 0;

for (const pluginDirName of fs.readdirSync(PLUGINS_DIR).sort()) {
  const pluginDir = path.join(PLUGINS_DIR, pluginDirName);
  const pkgJsonPath = path.join(pluginDir, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) continue;

  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
  const pluginExport: string | undefined = pkgJson.exports?.['./plugin'];
  if (!pluginExport) {
    problems.push(`${pkgJson.name}: missing "./plugin" export`);
    continue;
  }

  const entryPath = path.join(pluginDir, pluginExport);
  if (!fs.existsSync(entryPath)) {
    problems.push(`${pkgJson.name}: ${pluginExport} not found (build first)`);
    continue;
  }

  const distDir = path.dirname(entryPath);
  const jsFiles = fs.readdirSync(distDir).filter((f) => /\.[cm]?js$/.test(f));
  const extraFiles = jsFiles.filter((f) => f !== path.basename(entryPath));
  if (extraFiles.length) {
    problems.push(`${pkgJson.name}: expected a single file in ${path.relative(MONOREPO_ROOT, distDir)}, also found ${extraFiles.join(', ')}`);
  }

  const entryCode = fs.readFileSync(entryPath, 'utf-8');
  const relativeRequires = entryCode.match(/require\(\s*["']\.\.?\/[^"']*["']\s*\)/g);
  if (relativeRequires) {
    problems.push(`${pkgJson.name}: entry has relative requires: ${[...new Set(relativeRequires)].join(', ')}`);
  }

  checkedCount++;
}

if (problems.length) {
  console.error('Plugin bundle check failed:');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('\nPlugins must build to a single file. Set `outputOptions: { codeSplitting: false }` in tsdown.config.ts.');
  process.exit(1);
}
console.log(`Checked ${checkedCount} plugin bundles: all single-file`);
