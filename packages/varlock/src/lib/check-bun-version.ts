import semver from 'semver';

/**
 * Minimum Bun version required for varlock to work correctly.
 * Bun v1.3.3 introduced the ability to disable built-in .env file loading
 * via `--no-env-file` flag or `env = false` in bunfig.toml, which is necessary
 * to prevent conflicts with varlock's own .env loading.
 */
export const MIN_BUN_VERSION = '1.3.3';

/**
 * Checks if the current Bun version meets the minimum requirement.
 * Throws an error if running on an unsupported Bun version.
 */
export function checkBunVersion() {
  const bunVersion = process.versions.bun;
  if (!bunVersion) return;

  if (!semver.gte(bunVersion, MIN_BUN_VERSION)) {
    throw new Error(
      `Varlock requires Bun >= ${MIN_BUN_VERSION}, but you are using Bun ${bunVersion}.\n`
      + `Please upgrade Bun by running: \`bun upgrade\`\n`
      + `Bun ${MIN_BUN_VERSION} introduced the \`--no-env-file\` flag which is required to prevent `
      + `conflicts with varlock's own .env loading.`,
    );
  }
}
