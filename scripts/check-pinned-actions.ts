/**
 * Fails if any workflow or composite action references a remote action by tag/branch
 * instead of a full commit SHA. Each pin must also carry a comment naming the ref it
 * points at (`# v7.0.1`, or `# master` for actions without releases); Dependabot
 * rewrites a version comment together with the SHA.
 *
 * Usage: bun run scripts/check-pinned-actions.ts
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dirs = ['.github/workflows', '.github/actions'];

function listYamlFiles(dir: string): Array<string> {
  let entries: Array<string>;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return listYamlFiles(full);
    return /\.ya?ml$/.test(name) ? [full] : [];
  });
}

const problems: Array<string> = [];
for (const file of dirs.flatMap((d) => listYamlFiles(path.join(root, d)))) {
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    const match = line.match(/^\s*(?:-\s+)?uses:\s*['"]?([^\s'"#]+)['"]?\s*(#.*)?$/);
    if (!match) return;
    const [, ref, comment] = match;
    // local actions and docker images are not pinned by git ref
    if (ref.startsWith('./') || ref.startsWith('docker://')) return;
    const loc = `${path.relative(root, file)}:${i + 1}`;
    if (!/@[0-9a-f]{40}$/.test(ref)) {
      problems.push(`${loc}  ${ref}  (must be pinned to a full commit SHA)`);
    } else if (!comment || comment.replace(/^#\s*/, '') === '') {
      problems.push(`${loc}  ${ref}  (missing "# vX.Y.Z" comment naming the pinned ref)`);
    }
  });
}

if (problems.length) {
  console.error('Unpinned GitHub Actions found:\n');
  for (const p of problems) console.error(`  ${p}`);
  console.error('\nPin to a commit SHA with a version comment, e.g.');
  console.error('  uses: actions/checkout@<sha> # v7.0.1');
  process.exit(1);
}
console.log('All GitHub Actions are pinned to commit SHAs.');
