import { define } from 'gunshi';

export const commandSpec = define({
  name: 'flatten',
  description: 'Copy env files imported from outside this package into a self-contained directory, rewriting @import paths',
  args: {
    'out-dir': {
      type: 'string',
      description: 'Output directory (relative to cwd unless absolute)',
      default: '.env-flat',
    },
    'include-local': {
      type: 'boolean',
      description: 'Include .env.local / .env.*.local files (excluded by default)',
      default: false,
    },
    'vendor-plugins': {
      type: 'boolean',
      description: 'Copy npm plugins into the output so no runtime install is needed (for shell-less/offline/distroless runtimes). Uses the installed copy, downloading only if absent',
      default: false,
    },
  },
  examples: `
In a monorepo, a package's env files may @import files from sibling packages or the
workspace root. Those files are not available in contexts where only the package itself
is present, like the final stage of a Docker build.

\`varlock flatten\` copies everything reachable via @import into one self-contained
directory and rewrites the @import paths, so that directory can travel with the package.
Values are never resolved - this is a purely structural transform, safe to run in CI.

Examples:
  varlock flatten                    # flatten env files from the current directory into .env-flat/
  varlock flatten --out-dir dist/env # custom output location
  varlock flatten --include-local    # also include .env.local files (careful - these often hold secrets)
  varlock flatten --vendor-plugins   # also copy npm plugins into the output (self-contained, no runtime install)

Typical Dockerfile usage (builder stage has the full monorepo):
  RUN cd packages/api && varlock flatten
  # final stage:
  COPY --from=builder /repo/packages/api /app
  COPY --from=builder /repo/packages/api/.env-flat/ /app/
`.trim(),
});
