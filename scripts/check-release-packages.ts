/**
 * Determines which packages would be published in a preview release.
 * Uses `bumpy status --json` to find packages with pending changesets.
 *
 * Usage:
 *   bun run scripts/check-release-packages.ts
 *
 * Outputs (via GITHUB_OUTPUT if available):
 *   packages=["path1","path2"]
 *   includes-varlock=true|false
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MONOREPO_ROOT = path.resolve(__dirname, '..');

let bumpyStatusRaw: string;
try {
  bumpyStatusRaw = execSync('bunx @varlock/bumpy status --json 2>/dev/null', { cwd: MONOREPO_ROOT }).toString();
} catch (execErr: any) {
  // bumpy may exit non-zero with warnings but still output valid JSON
  bumpyStatusRaw = execErr.stdout?.toString() ?? '';
}

let releasePackagePaths: Array<string> = [];

if (bumpyStatusRaw) {
  // stdout may contain warning lines before the JSON — extract just the JSON
  const jsonMatch = bumpyStatusRaw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    const bumpyStatus = JSON.parse(jsonMatch[0]);
    releasePackagePaths = bumpyStatus.releases
      .filter((r: any) => r.publishTargets?.includes('npm'))
      .map((r: any) => path.resolve(MONOREPO_ROOT, r.dir));
  }
}

// filter out vscode extension which is not released via npm
releasePackagePaths = releasePackagePaths.filter((p: string) => !p.endsWith('packages/vscode-plugin'));

const includesVarlock = releasePackagePaths.some((p) => p.endsWith('packages/varlock'));

console.log('Packages to release:', releasePackagePaths);
console.log('Includes varlock:', includesVarlock);

// Write to GITHUB_OUTPUT if running in CI
const githubOutput = process.env.GITHUB_OUTPUT;
if (githubOutput) {
  fs.appendFileSync(githubOutput, `packages=${JSON.stringify(releasePackagePaths)}\n`);
  fs.appendFileSync(githubOutput, `includes-varlock=${includesVarlock}\n`);
}
