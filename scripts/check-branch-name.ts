// lefthook pre-push check: blocks pushing auto-generated agent worktree
// branch names (e.g. claude/dreamy-jones-a79c22, codex/eager-dijkstra-468e8b).
// Rename to something meaningful first — see AGENTS.md "Branches & pull requests".

import { execSync } from 'node:child_process';

const branch = execSync('git branch --show-current', { encoding: 'utf8' }).trim();

if (/^((claude|codex)\/)?[a-z]+-[a-z]+-[0-9a-f]{4,8}$/.test(branch)) {
  console.error(`Blocked: branch '${branch}' looks like an auto-generated worktree name.`);
  console.error('Rename it to describe the change (git branch -m <meaningful-name>) before pushing.');
  console.error('See AGENTS.md "Branches & pull requests".');
  process.exit(1);
}
