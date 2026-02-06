import { spawnAsync } from './exec-helpers';
import { dirname } from 'node:path';

export async function checkIsFileGitIgnored(path: string, warnIfNotGitRepo = false) {
  try {
    // Use spawnAsync with array arguments to properly handle paths with spaces
    // Pass cwd to run git from the file's directory
    await spawnAsync('git', ['check-ignore', path, '-q'], { cwd: dirname(path) });
    return true;
  } catch (err) {
    const stderr = (err as any).data as string;
    // git is not installed, so we can't check
    if (
      (err as any).exitCode === 127
      || stderr.includes('not found')
      || stderr.includes('not recognized') // windows
    ) {
      return undefined;
    }

    // other file related issues could throw this
    if ((err as any).code === 'ENOENT') return undefined;
    // `git check-ignore -q` exits with code 1 but no other error if is not ignored
    if (stderr === '') return false;
    if (stderr.includes('not a git repository')) {
      if (warnIfNotGitRepo) {
        // eslint-disable-next-line no-console
        console.log('🔶 Your code is not currently in a git repository - run `git init` to initialize a new repo.');
      }
      return false;
    }
    // otherwise we'll let it throw since something else is happening
    throw err;
  }
}
