import { define } from 'gunshi';
import { FROZEN_ENV_FILE_NAME } from '../../lib/frozen-env-file';

export const commandSpec = define({
  name: 'freeze',
  description: 'Resolve env values once and write them to an encrypted file that ships with your deploy',
  args: {
    out: {
      type: 'string',
      short: 'o',
      description: 'Output file path (relative to cwd unless absolute)',
      default: FROZEN_ENV_FILE_NAME,
    },
    env: {
      type: 'string',
      description: 'Set the environment (e.g., production, development, etc) - will be overridden by @currentEnv in the schema if present',
    },
    path: {
      type: 'string',
      short: 'p',
      multiple: true,
      description: 'Path to a specific .env file or directory to use as the entry point (can be specified multiple times)',
    },
    'allow-plaintext': {
      type: 'boolean',
      description: 'Write the file unencrypted when _VARLOCK_ENV_KEY is not set. Every resolved secret will sit in plaintext inside your deploy artifact',
      default: false,
    },
    'clear-cache': {
      type: 'boolean',
      description: 'Clear cache and re-resolve all values',
    },
    'skip-cache': {
      type: 'boolean',
      description: 'Skip cache entirely for this invocation',
    },
  },
  examples: `
Resolves every value once and writes the result to an encrypted file, so your app can boot
from those exact values without re-resolving. Run it at deploy time, and ship the file
inside your deploy artifact (image layer, deployment bundle) so config and code travel and
roll back as one unit.

This is aimed at platforms where you can control the boot command but can't feed env vars
in atomically with a deploy, and at apps without a build step that would otherwise inline
them (Elysia/Hono/Fastify on Bun or Node, distroless Docker images).

At boot, varlock uses the file automatically if it is present at the default path - no CLI,
no .env files, and no resolver credentials needed in the runtime image. Set
_VARLOCK_ENV_KEY on your platform so the file can be decrypted.

The tradeoff: values are pinned. Rotating a secret takes effect on your next deploy, not on
the next restart.

Examples:
  varlock freeze                        # write ${FROZEN_ENV_FILE_NAME} in the current directory
  varlock freeze --env production       # resolve for a specific environment
  varlock freeze --out dist/env.frozen  # custom output location
  varlock freeze --skip-cache           # bypass the cache so values are freshly resolved

Typical CI usage:
  varlock generate-key --plain          # once - set the result as _VARLOCK_ENV_KEY everywhere
  varlock freeze --env production       # in your deploy job, with resolver credentials present
  docker build .                        # the file is copied into the image

Then boot the app normally (\`bun server.js\`) with _VARLOCK_ENV_KEY set in the runtime env.
`.trim(),
});
