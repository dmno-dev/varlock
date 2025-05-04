import { asyncExec } from './exec-helpers';

export async function checkIsFileGitIgnored(path: string, warnIfNotGitRepo = false) {
  try {
    await asyncExec(`git check-ignore ${path} -q`);
    return true;
  } catch (err) {
    // `git check-ignore -q` exits with code 1 but no other error if is not ignored
    if ((err as any).stderr === '') return false;
    if ((err as any).stderr.includes('not a git repository')) {
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
