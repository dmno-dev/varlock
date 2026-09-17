import packageJson from '../../package.json';

/**
 * Published version of this varlock package, baked into builds at bundle time (rolldown
 * treeshakes the json import down to the version string, so no other package.json contents
 * land in the bundle).
 *
 * This is the bare published version, with no build type attached. Use it when comparing
 * against another package's declared version (see `checkLocalVersionMismatch`); for
 * anything identifying the running build, use `VARLOCK_VERSION_ID`.
 */
export const VARLOCK_VERSION: string = packageJson.version;

/**
 * Identifies the running build: the published version, suffixed with the build type unless
 * this is a release build (`1.19.0`, `1.19.0-dev`, `1.19.0-preview`, `1.19.0-test`). Still
 * valid semver, so it stays parseable and comparable.
 *
 * This is what `varlock --version` prints, what telemetry reports, and what stamps
 * serialized `__VARLOCK_ENV` blobs with their producer version. Producers and consumers can
 * legitimately be different builds: a parent `varlock run` vs a child process's varlock
 * dependency, a global CLI vs a local package, or runtime code bundled into an integration
 * (e.g. the nextjs @next/env replacement) vs the installed varlock that resolved the env.
 * A local dev build and the installed release it is standing in for share a version number,
 * so the suffix is often the only thing that tells them apart.
 */
// TODO: for preview builds, it would be nice to track which preview it is (PR number or commit hash)
export const VARLOCK_VERSION_ID: string = __VARLOCK_BUILD_TYPE__ === 'release'
  ? VARLOCK_VERSION
  : `${VARLOCK_VERSION}-${__VARLOCK_BUILD_TYPE__}`;
