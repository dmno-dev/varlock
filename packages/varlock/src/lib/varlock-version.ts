import packageJson from '../../package.json';

/**
 * Which build of varlock this is, including the build type when it is not a
 * release: `1.17.1`, or `1.17.1-dev`.
 *
 * The suffix is not cosmetic. A dev or preview build is not the artifact the
 * release pipeline produced, and that is exactly the sort of thing worth
 * noticing on an approval prompt, so anything that reports a version reports
 * this one rather than the bare number from package.json.
 *
 * `__VARLOCK_BUILD_TYPE__` is substituted at build time and does not exist when
 * a source file is run directly, which some tests do: reading it bare would
 * throw a ReferenceError at import time, in a module whose only job is to name
 * a version. So it is read defensively, and a source tree with no build behind
 * it reports the bare package version.
 */
const buildType = typeof __VARLOCK_BUILD_TYPE__ === 'undefined' ? 'release' : __VARLOCK_BUILD_TYPE__;

export const VARLOCK_VERSION = buildType === 'release'
  ? packageJson.version
  : `${packageJson.version}-${buildType}`;
