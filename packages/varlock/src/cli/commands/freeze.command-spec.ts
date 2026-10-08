import { define } from 'gunshi';
import { FROZEN_ENV_FILE_NAME } from '../../lib/frozen-env-file';

export const commandSpec = define({
  name: 'freeze',
  description: 'Resolve env values once and write them to an encrypted file that ships with your deploy',
  args: {
    out: {
      type: 'string',
      short: 'o',
      description: 'Output file path (relative to cwd unless absolute), or `-` to write the payload to stdout',
      default: FROZEN_ENV_FILE_NAME,
    },
    env: {
      type: 'string',
      // kept for parity with `load`, but the environment should come from the schema's
      // @currentEnv item (`APP_ENV=production varlock freeze`); the command refuses a
      // mismatch rather than baking the wrong environment into an artifact
      description: 'Set the environment - prefer setting the @currentEnv item instead (e.g. APP_ENV=production varlock freeze)',
      hidden: true,
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

Use it wherever a framework integration is not already baking values at build time
(Elysia/Hono/Fastify on Bun or Node, distroless Docker images). On a platform that runs the
app for you (Heroku, Railway, Render, Fly) run it in the build or release phase: the boot
command is not yours to wrap in \`varlock run\`, so resolving at deploy time is the only option.
Where you do own the boot command, it is the explicit choice to resolve once per release
instead of on every boot.

At boot, set _VARLOCK_USE_FROZEN_ENV=1 (or \`varlock run --frozen\`) and varlock boots from the
file - no CLI, no .env files, and no resolver credentials needed in the runtime image. Set
_VARLOCK_ENV_KEY on your platform so the file can be decrypted.

The tradeoff: values are fixed once frozen. Rotating a secret takes effect on your next deploy, not on
the next restart.

Examples:
  varlock freeze                        # write ${FROZEN_ENV_FILE_NAME} in the current directory
  APP_ENV=production varlock freeze     # resolve for a specific environment
  varlock freeze --out dist/env.frozen  # custom output location
  varlock freeze --out -                # write the payload to stdout instead of a file
  varlock freeze --skip-cache           # bypass the cache so values are freshly resolved

Typical CI usage:
  varlock generate-key --plain          # once - set the result as _VARLOCK_ENV_KEY everywhere
  APP_ENV=production varlock freeze     # in your deploy job, with resolver credentials present
  docker build .                        # the file is copied into the image

Then boot the app normally (\`bun server.js\`) with _VARLOCK_USE_FROZEN_ENV=1 and _VARLOCK_ENV_KEY
set in the runtime env.

If your platform takes env vars but gives you no way to get a file into the deploy unit,
--out - writes the same payload to stdout so you can carry it in one variable instead:

  export __VARLOCK_ENV=$(varlock freeze --out -)   # at deploy time
  _VARLOCK_USE_INJECTED_ENV=1                      # in the runtime environment

The summary goes to stderr in that mode, so the payload is all that stdout carries.
`.trim(),
});
