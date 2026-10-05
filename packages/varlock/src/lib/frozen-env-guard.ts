import fs from 'node:fs';
import path from 'node:path';

/**
 * The parts of the frozen env file contract that framework integrations need, kept free of
 * heavy imports (no crypto) because it is exposed as its own entry (`varlock/frozen-env-guard`)
 * and loaded into dev servers. The reader itself lives in frozen-env-file.
 */

/** Default filename, resolved relative to cwd (the app dir at boot, per-package in a monorepo). */
export const FROZEN_ENV_FILE_NAME = '.varlock-frozen-env';

/** user-controllable behavior flag (leading single underscore per convention) */
export const USE_FROZEN_ENV_VAR = '_VARLOCK_USE_FROZEN_ENV';

type EnvRecord = Record<string, string | undefined>;

/**
 * Interpret `_VARLOCK_USE_FROZEN_ENV`:
 *  - unset         -> the default path, used if present
 *  - `1`/`true`    -> the default path, required (assert the frozen env is actually in effect)
 *  - `0`/`false`   -> off (undefined)
 *  - anything else -> that path, required
 *
 * Unlike `getUseInjectedEnvMode`, an unrecognized value is a path, so `=off` names a file
 * called `off` and hard-errors as missing. A typo is still never silently permissive.
 */
export function resolveFrozenEnvFileMode(
  env: EnvRecord,
  cwd: string,
): { filePath: string, required: boolean } | undefined {
  const rawValue = env[USE_FROZEN_ENV_VAR]?.trim();
  const defaultPath = path.resolve(cwd, FROZEN_ENV_FILE_NAME);
  if (!rawValue) return { filePath: defaultPath, required: false };
  const normalized = rawValue.toLowerCase();
  if (normalized === '0' || normalized === 'false') return undefined;
  if (normalized === '1' || normalized === 'true') return { filePath: defaultPath, required: true };
  return { filePath: path.resolve(cwd, rawValue), required: true };
}

/**
 * Throw when a frozen env file is present in a dev server's project directory.
 *
 * `varlock freeze` output is a deploy artifact, so one sitting in a dev checkout is always a
 * leftover or a mistake. Left alone it is confusing either way: the dev server resolves from
 * .env files while `varlock run` and `varlock/auto-load` in the same directory boot from the
 * file. Dev is where a throw is cheap - you are at the keyboard and the fix takes seconds -
 * whereas a notice would scroll past in dev server output.
 *
 * `_VARLOCK_USE_FROZEN_ENV=0` opts out, for anyone who needs the file around.
 */
export function assertNoFrozenEnvFileInDev(opts: {
  /** the project directory the dev server resolves env from */
  cwd: string,
  /** what is running, for the message (e.g. `vite dev`) */
  devCommand: string,
  env?: EnvRecord,
}) {
  const mode = resolveFrozenEnvFileMode(opts.env ?? process.env, opts.cwd);
  if (!mode || !fs.existsSync(mode.filePath)) return;
  const relPath = path.relative(opts.cwd, mode.filePath) || mode.filePath;
  throw new Error([
    `[varlock] ${relPath} is present, but \`${opts.devCommand}\` does not use frozen env files.`,
    '[varlock] `varlock freeze` output is a deploy artifact: here the dev server resolves from your .env files,',
    '[varlock] while `varlock run` and `varlock/auto-load` in this directory would boot from the frozen file.',
    `[varlock] Delete it (\`rm ${relPath}\`), or set ${USE_FROZEN_ENV_VAR}=0 to keep it and ignore it.`,
  ].join('\n'));
}
