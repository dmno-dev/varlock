const JS_FILES_GLOB = '*.{js,jsx,ts,tsx,mjs,mts}';

/**
 * Build the turbopack `rules` entry that runs our loader, shaped for the installed Next version.
 *
 * The browser gets its own rule (loader option `browser: true`) wherever turbopack supports
 * conditions, so the loader knows a file is client code even without a 'use client' directive
 * (e.g. instrumentation-client.ts, or plain modules imported from client components).
 *
 * On Next 15, applying JS loaders to edge-context files (middleware, edge routes) triggers a
 * fatal analysis issue in turbopack's own loader-runner (it uses process.cwd/path.sep, which
 * don't exist in the edge environment), and every dev page render 500s. Next 15.5 added
 * per-condition rules, so we scope the loader to node + browser contexts there. Edge files read
 * env through the runtime ENV proxy instead (env is available in the edge sandbox), they just
 * lose static inlining. Next 16 fixed the underlying analysis, so its rules cover edge too (edge
 * files still need the loader for inlining during turbopack builds), and it replaced the
 * per-condition object with a `condition` key.
 */
export function getTurbopackLoaderRules(opts: {
  nextVersion: [number, number];
  loaderPath: string;
  isBuild: boolean;
}): Record<string, unknown> {
  const [nextMajor, nextMinor] = opts.nextVersion;
  const makeLoaderRule = (browser?: boolean) => ({
    loaders: [
      {
        loader: opts.loaderPath,
        options: { bundler: 'turbopack', dev: !opts.isBuild, ...browser && { browser: true } },
      },
    ],
  });

  if (nextMajor >= 16) {
    return {
      [JS_FILES_GLOB]: [
        { condition: 'browser', ...makeLoaderRule(true) },
        { condition: { not: 'browser' }, ...makeLoaderRule() },
      ],
    };
  }
  if (nextMajor === 15 && nextMinor >= 5) {
    return { [JS_FILES_GLOB]: { node: makeLoaderRule(), browser: makeLoaderRule(true) } };
  }
  // no conditions available - the loader falls back to sniffing 'use client' and file names
  return { [JS_FILES_GLOB]: makeLoaderRule() };
}
