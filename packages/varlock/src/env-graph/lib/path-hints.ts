/**
 * `@import()` and `@plugin()` paths are written the same way on every platform: `./` and `../`
 * relative to the declaring file, `/` absolute, `~/` for the home directory. Windows-native path
 * syntax is deliberately not supported.
 *
 * This turns those shapes into something the user can act on, instead of the generic "unsupported"
 * error they would otherwise land on. Returns undefined for anything that is not a windows-ism, so
 * callers fall back to their own message.
 */
export function getWindowsPathHint(declaredPath: string): string | undefined {
  // drive-letter (`C:\x`, `C:/x`) or UNC (`\\server\share`) - these have no portable spelling,
  // so forward slashes alone would not fix them
  if (/^[a-zA-Z]:[\\/]/.test(declaredPath) || declaredPath.startsWith('\\\\')) {
    return 'absolute windows paths are not supported, use a path relative to this file or `~/` for the home directory';
  }
  // any other backslash is just a separator, which the user can spell the portable way
  if (declaredPath.includes('\\')) {
    return 'paths use forward slashes on every platform, including windows (e.g. `../shared/.env.schema`)';
  }
  return undefined;
}
