import path from 'node:path';
import fs from 'node:fs';

/**
 * When running as a standalone binary (SEA build), checks if varlock is also
 * installed in a local node_modules directory. If found and the versions differ,
 * returns a warning message to alert the user about the mismatch.
 *
 * This helps prevent confusing errors when users have both a standalone binary
 * (e.g. installed via homebrew/curl) and a project-level npm install with
 * different versions.
 */
export function checkLocalVersionMismatch(currentVersion: string): string | undefined {
  // Walk up from cwd looking for node_modules/varlock/package.json
  let currentDir = process.cwd();
  while (currentDir) {
    const localPkgJsonPath = path.join(currentDir, 'node_modules', 'varlock', 'package.json');
    if (fs.existsSync(localPkgJsonPath)) {
      try {
        const localPkgJson = JSON.parse(fs.readFileSync(localPkgJsonPath, 'utf-8'));
        const localVersion = localPkgJson.version;
        if (localVersion && localVersion !== currentVersion) {
          return 'Varlock version mismatch detected!\n'
            + `  Standalone binary version: ${currentVersion}\n`
            + `  Local installed version:   ${localVersion}\n`
            + 'You are running the standalone binary, but a different version of varlock is installed in this project\'s node_modules.\n'
            + 'This can cause unexpected errors. Please update your standalone binary or use the locally installed version instead\n'
            + '(e.g. via npx varlock, pnpm exec varlock, or bunx varlock).';
        }
      } catch {
        // If we can't read/parse the package.json, just skip the check
      }
      // Found node_modules/varlock - stop walking regardless of outcome
      break;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }
  return undefined;
}
