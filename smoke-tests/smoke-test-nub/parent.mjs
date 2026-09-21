import { spawnSync } from 'node:child_process';
// a child process with a command-local override: its auto-load must reject blob reuse and
// re-resolve via the varlock CLI, whose `node` shebang resolves through nub's PATH shim
const r = spawnSync(process.execPath, ['app-autoload.mjs'], { env: { ...process.env, PUBLIC_VAR: 'cmdlocal', DEBUG: 'varlock:auto-load' }, encoding: 'utf-8', timeout: 30000 });
process.stdout.write(r.stdout);
process.stderr.write(r.stderr);
console.log('child exit:', r.status);
