import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync, execSync } from 'node:child_process';

// weird tsup issue using `typeof execSync` from node:child_process
// see https://github.com/egoist/tsup/issues/1367
import type { execSync as execSyncType } from 'child_process';

const platform = os.platform();
const isWindows = platform.match(/^win/i);


/**
 * Walk up the directory tree from startDir looking for a node_modules/.bin/varlock binary.
 * Returns the full path to the binary if found, or null if not found.
 */
function findVarlockBin(startDir: string): string | null {
  let currentDir = startDir;
  while (currentDir) {
    const possibleBinPath = path.join(currentDir, 'node_modules', '.bin');
    if (fs.existsSync(possibleBinPath)) {
      const possibleVarlockPath = path.join(possibleBinPath, isWindows ? 'varlock.exe' : 'varlock');
      if (fs.existsSync(possibleVarlockPath)) {
        return possibleVarlockPath;
      }
      // Found a .bin directory but varlock is not in it - keep walking up.
      // In a monorepo the root node_modules/.bin may exist without varlock,
      // which is installed only in a sub-package.
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }
  return null;
}

/**
 * small helper to call execSync and call the varlock cli
 *
 * when end user runs via a package manager, it will inject node_modules/.bin into PATH
 * but otherwise we may need to try to find that path ourselves
 */
export function execSyncVarlock(
  command: string,
  opts?: (Parameters<typeof execSyncType>[1] & {
    exitOnError?: boolean,
    showLogsOnError?: boolean,
    /**
     * Additional directory to start searching for the varlock binary from.
     * Searched before process.cwd(). Pass `import.meta.dirname` from the
     * call-site so that in monorepos the binary installed next to the
     * importing package is found even when cwd is an unrelated workspace root.
     */
    callerDir?: string,
  }),
) {
  try {
    // in most cases, user will be running via their package manager
    // and a package.json script (ie `pnpm run start`)
    // which will inject node_modules/.bin into PATH
    try {
      const result = execSync(`varlock ${command}`, {
        ...opts?.env && { env: opts.env },
        ...opts?.cwd && { cwd: opts.cwd },
        stdio: 'pipe',
      });
      return result.toString();
    } catch (err) {
      // code 127 means not found (on linux only)
      if (!isWindows && (err as any).status !== 127) throw err;
      // on windows, we'll just do the extra checks anyway
    }

    // if varlock was not found, it either means it is not installed
    // or we must find the path to node_modules/.bin ourselves.
    // Search from cwd (if provided), callerDir, then process.cwd().
    // This handles monorepo setups where cwd may be an unrelated workspace
    // root while varlock is only installed in a sub-package - the callerDir
    // supplied by auto-load.ts points inside that sub-package's node_modules.
    const cwdStr = opts?.cwd ? String(opts.cwd) : undefined;
    const searchDirs = [
      ...(cwdStr ? [cwdStr] : []),
      ...(opts?.callerDir ? [opts.callerDir] : []),
      process.cwd(),
    ];

    for (const startDir of searchDirs) {
      const varlockPath = findVarlockBin(startDir);
      if (varlockPath) {
        const result = execFileSync(varlockPath, command.split(' '), {
          ...opts,
          stdio: 'pipe',
        });
        return result.toString();
      }
    }
    throw new Error('Unable to find varlock executable');
  } catch (err) {
    const errAny = err as any;
    if (opts?.showLogsOnError) {
      /* eslint-disable no-console */
      if (errAny.stdout) console.log(errAny.stdout.toString());
      if (errAny.stderr) console.error(errAny.stderr.toString());

      if (!errAny.stdout && !errAny.stderr) {
        console.error(errAny);
      }
    }
    if (opts?.exitOnError) {
      process.exit((err as any).status ?? 1);
    }
    throw err;
  }
}
