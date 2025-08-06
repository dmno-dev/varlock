import { asyncExec } from './exec-helpers';

export async function checkIsFileGitIgnored(path: string, warnIfNotGitRepo = false) {
  try {
    await asyncExec(`git check-ignore ${path} -q`);
    return true;
  } catch (err) {
    const stderr = (err as any).stderr as string;
    // git is not installed, so we don't know
    if (stderr.includes('not found')) return undefined;
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
