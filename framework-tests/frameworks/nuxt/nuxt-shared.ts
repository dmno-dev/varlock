/*
Nuxt framework tests, run against both supported majors (see nuxt-v3.test.ts /
nuxt-v4.test.ts).

Two things make Nuxt different from a plain vite app, and both are covered here:

1. Nuxt 4 points vite's `root` at the srcDir (`app/` by default) while
   `.env.schema` lives at the project root. The module has to tell the vite
   plugin where the project root actually is, or every build-time `ENV.*`
   replacement is silently dropped. The default layout (app/app.vue) is the
   regression guard; Nuxt 3's flat layout (srcDir = project root) covers the
   other arrangement.
2. Nitro rebuilds the server with its own rollup pass, so the init module
   injected into vite's SSR entry never reaches `.output/server` - and server
   routes are never in vite's module graph at all. The module registers the
   same init as a nitro plugin; the server-route and leak scenarios cover it.
*/
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  describe, beforeAll, afterAll,
} from 'vitest';
import { FrameworkTestEnv } from '../../harness/index';

export function defineNuxtTests(nuxtVersion: number, testDir: string, opts: { portBase: number }) {
  let nextPort = opts.portBase;
  const port = () => nextPort++;
  const projectDirName = `nuxt-v${nuxtVersion}`;
  // Nuxt 4's default layout nests the app under `app/`; Nuxt 3's srcDir is the
  // project root itself
  const appEntryPath = nuxtVersion >= 4 ? 'app/app.vue' : 'app.vue';
  // the dev-restart scenario edits one value in the fixture schema mid-session;
  // derived from the fixture rather than inlined so the two can't drift apart
  const baseSchema = readFileSync(path.join(testDir, 'files/schemas/.env.schema'), 'utf8');
  const editedSchema = baseSchema.replace('PUBLIC_VAR=public-var-value', 'PUBLIC_VAR=restarted-var-value');
  if (editedSchema === baseSchema) throw new Error('nuxt fixture schema no longer contains PUBLIC_VAR=public-var-value');

  describe(`Nuxt v${nuxtVersion}`, () => {
    const env = new FrameworkTestEnv({
      testDir,
      framework: projectDirName,
      packageManager: 'pnpm',
      dependencies: {
        nuxt: `^${nuxtVersion}`,
        vue: '^3',
        'vue-router': '^4',
        varlock: 'will-be-replaced',
        '@varlock/nuxt-integration': 'will-be-replaced',
      },
      packageJsonMerge: {
        packageManager: 'pnpm@10.17.0',
      },
      templateFiles: {
        '.env.schema': 'schemas/.env.schema',
        '.env.dev': 'schemas/.env.dev',
        '.env.prod': 'schemas/.env.prod',
        [appEntryPath]: 'pages/basic-page.vue',
        'nuxt.config.ts': 'configs/nuxt.config.ts',
      },
    });

    beforeAll(() => env.setup(), 300_000);
    afterAll(() => env.teardown());

    env.describeScenario('build: non-sensitive inlined, sensitive not leaked', {
      command: 'nuxt build',
      expectSuccess: true,
      timeout: 300_000,
      fileAssertions: [
        {
          // template-var-value is only referenced via direct `{{ ENV.X }}`
          // template interpolation, which the vue compiler turns into
          // `_unref(ENV).X` in production builds, so it only shows up in the
          // bundle if the replacer handles that shape
          description: 'client bundle inlines non-sensitive values',
          fileGlob: '.output/public/**/*.js',
          shouldContain: ['public-var-value', 'env-specific-var--dev', 'template-var-value'],
          // dynamic values must never be inlined - they are served at runtime
          // by the injected public-env endpoint instead
          shouldNotContain: ['public-dynamic-value'],
        },
        {
          description: 'sensitive value is absent from all build output',
          fileGlob: '.output/**/*.{js,mjs,html}',
          shouldNotContain: ['super-secret-value'],
        },
        {
          description: 'nitro server bundle carries the varlock init',
          fileGlob: '.output/server/chunks/nitro/*.mjs',
          shouldContain: ['initVarlockEnv'],
        },
        {
          // the module registers the `@generateTypes` output (env.d.ts here)
          // with nuxt's generated tsconfigs via a type template
          description: 'generated env types are registered with nuxt',
          fileGlob: '.nuxt/types/varlock-env.d.ts',
          shouldContain: ['env.d.ts'],
        },
      ],
    });

    env.describeScenario('build: env-specific vars use prod environment', {
      command: 'nuxt build',
      expectSuccess: true,
      timeout: 300_000,
      env: { APP_ENV: 'prod' },
      fileAssertions: [
        {
          description: 'prod-specific value is inlined',
          fileGlob: '.output/public/**/*.js',
          shouldContain: ['env-specific-var--prod'],
          shouldNotContain: ['env-specific-var--dev', 'env-specific-var--default'],
        },
      ],
    });

    // `nuxt build --cwd <dir>` does not chdir, so process.cwd() is not the
    // project root. Everything that reads varlock config before vite's `config`
    // hook runs - notably the nitro init template - has to be told the real root,
    // or a `resolved-env` build bakes an empty env and every route 500s.
    env.describeScenario('build: --cwd from a different working directory', {
      // run from the parent dir so process.cwd() is not the project root. The
      // nuxt binary is invoked directly rather than via `pnpm exec`, which would
      // walk up from the parent to a different package root.
      command: `sh -c 'cd .. && node ${projectDirName}/node_modules/nuxt/bin/nuxt.mjs build --cwd ${projectDirName}'`,
      expectSuccess: true,
      timeout: 300_000,
      templateFiles: {
        'nuxt.config.ts': 'configs/nuxt.config.resolved-env.ts',
      },
      fileAssertions: [
        {
          description: 'client bundle still inlines non-sensitive values',
          fileGlob: '.output/public/**/*.js',
          shouldContain: ['public-var-value'],
        },
        {
          description: 'nitro server bundle carries a populated resolved env',
          fileGlob: '.output/server/chunks/nitro/*.mjs',
          shouldContain: ['__varlockLoadedEnv', 'PUBLIC_VAR'],
        },
      ],
    });

    const devPort = port();
    env.describeDevScenario('dev: ENV available in pages and server routes', {
      command: `nuxt dev --no-fork --port ${devPort} < /dev/null`,
      readyPattern: new RegExp(`localhost:${devPort}`),
      readyTimeout: 120_000,
      timeout: 300_000,
      templateFiles: {
        'server/api/env.get.ts': 'routes/env-endpoint.ts',
        'server/api/log.get.ts': 'routes/log-endpoint.ts',
      },
      requests: [
        {
          path: '/api/env',
          bodyAssertions: {
            // nitro pretty-prints JSON responses in dev, so the key/value pairs
            // carry a space that the production-server scenarios don't have
            shouldContain: ['"PUBLIC_VAR": "public-var-value"', '"HAS_SECRET": "yes"'],
            shouldNotContain: ['super-secret-value'],
          },
        },
        {
          path: '/',
          bodyAssertions: {
            shouldContain: ['public-var-value', '1234/number', 'env-specific-var--dev', 'template-var-value'],
            shouldNotContain: ['super-secret-value'],
          },
        },
        { path: '/api/log' },
      ],
      outputAssertions: [
        {
          description: 'secret is redacted from server logs',
          shouldContain: ['secret-log-test:'],
          shouldNotContain: ['super-secret-value'],
        },
      ],
    });

    // An env file edit restarts the dev server in-process: the nuxt CLI closes
    // the old instance and re-evaluates nuxt.config in the SAME process. The
    // config's `import 'varlock/auto-load'` is already in the module cache and
    // does not re-execute, so without the module re-resolving env on the way
    // into a restart, every config-time `ENV` read would replay the values from
    // first boot - runtime values (server routes, pages) would update while
    // `app.head.title` and `runtimeConfig` stayed pinned to the old ones until a
    // manual restart.
    const restartPort = port();
    env.describeDevScenario('dev: config-time env is refreshed on restart', {
      command: `nuxt dev --no-fork --port ${restartPort} < /dev/null`,
      // nuxt logs the `Local:` banner only on first boot; the nitro build line
      // is re-logged on every restart and comes after both vite builds
      readyPattern: /Nuxt Nitro server built/,
      readyTimeout: 120_000,
      timeout: 300_000,
      templateFiles: {
        'nuxt.config.ts': 'configs/nuxt.config.config-time-env.ts',
        'server/api/env.get.ts': 'routes/env-endpoint.ts',
        'server/api/runtime-config.get.ts': 'routes/runtime-config-endpoint.ts',
      },
      requests: [
        {
          label: 'config-time title before the edit',
          path: '/',
          bodyAssertions: { shouldContain: ['<title>public-var-value</title>'] },
        },
        {
          // rewrite the schema with a new PUBLIC_VAR - the module watches every
          // varlock-loaded env file, so this triggers the restart
          label: 'config-time title after the auto-restart',
          path: '/',
          fileEdits: { '.env.schema': editedSchema },
          bodyAssertions: {
            shouldContain: ['<title>restarted-var-value</title>'],
            shouldNotContain: ['public-var-value'],
          },
        },
        {
          // the same value read at config time, via runtimeConfig
          label: 'runtimeConfig captured at config time is fresh',
          path: '/api/runtime-config',
          bodyAssertions: {
            shouldContain: ['"varlockConfigProbe": "restarted-var-value"'],
            shouldNotContain: ['public-var-value'],
          },
        },
        {
          // runtime reads reach ENV through the nitro init plugin rather than
          // config evaluation - asserting both pins down which half went stale
          label: 'runtime env is fresh too',
          path: '/api/env',
          bodyAssertions: {
            shouldContain: ['"PUBLIC_VAR": "restarted-var-value"'],
            shouldNotContain: ['public-var-value'],
          },
        },
      ],
    });

    // `init-only` (the default) expects the env to already be in the server
    // process, which is what `varlock run` does.
    env.describeDevScenario('production server: init-only under `varlock run`', {
      command: 'nuxt build < /dev/null && pnpm exec varlock run -- node .output/server/index.mjs',
      env: { PORT: String(port()), HOST: '127.0.0.1' },
      readyPattern: /Listening on/,
      readyTimeout: 300_000,
      timeout: 420_000,
      templateFiles: {
        'server/api/env.get.ts': 'routes/env-endpoint.ts',
      },
      requests: [
        {
          path: '/api/env',
          bodyAssertions: {
            shouldContain: ['"PUBLIC_VAR":"public-var-value"', '"HAS_SECRET":"yes"'],
            shouldNotContain: ['super-secret-value'],
          },
        },
        {
          // auto-injected because the schema declares a public+dynamic item
          path: '/__varlock/public-env',
          bodyAssertions: {
            shouldContain: ['"PUBLIC_DYNAMIC_VAR":"public-dynamic-value"'],
            shouldNotContain: ['super-secret-value', 'PUBLIC_VAR"'],
          },
        },
      ],
    });

    // Env used inside nuxt.config itself, via `import 'varlock/auto-load'` at
    // the top of the config - the documented pattern for config-time access.
    // The value is captured at config evaluation, flows into runtimeConfig,
    // and must survive the build into the running server.
    env.describeDevScenario('production server: env in nuxt.config via auto-load', {
      command: 'nuxt build < /dev/null && pnpm exec varlock run -- node .output/server/index.mjs',
      env: { PORT: String(port()), HOST: '127.0.0.1' },
      readyPattern: /Listening on/,
      readyTimeout: 300_000,
      timeout: 420_000,
      templateFiles: {
        'nuxt.config.ts': 'configs/nuxt.config.env-in-config.ts',
        'server/api/runtime-config.get.ts': 'routes/runtime-config-endpoint.ts',
      },
      requests: [
        {
          path: '/api/runtime-config',
          bodyAssertions: {
            shouldContain: ['"varlockConfigProbe":"public-var-value"'],
            shouldNotContain: ['super-secret-value'],
          },
        },
      ],
    });

    // `auto-load` has to survive nitro's rollup pass, which treats external
    // modules as side-effect free - a bare `import 'varlock/auto-load'` gets
    // tree-shaken away and the server starts with no env at all.
    env.describeDevScenario('production server: auto-load runs without `varlock run`', {
      // the whole chain runs inside a single `pnpm exec` shell so the server
      // half also gets the test project's node_modules/.bin on PATH - otherwise
      // auto-load's `varlock` CLI spawn resolves to whatever varlock happens to
      // be on the harness PATH instead of the packed one under test
      command: "sh -c 'nuxt build < /dev/null && node .output/server/index.mjs'",
      env: { PORT: String(port()), HOST: '127.0.0.1' },
      readyPattern: /Listening on/,
      readyTimeout: 300_000,
      timeout: 420_000,
      templateFiles: {
        'nuxt.config.ts': 'configs/nuxt.config.auto-load.ts',
        'server/api/env.get.ts': 'routes/env-endpoint.ts',
      },
      requests: [
        {
          path: '/api/env',
          bodyAssertions: {
            shouldContain: ['"PUBLIC_VAR":"public-var-value"', '"HAS_SECRET":"yes"'],
            shouldNotContain: ['super-secret-value'],
          },
        },
      ],
    });

    env.describeDevScenario('production server: leaked secret is blocked in the response', {
      command: 'nuxt build < /dev/null && pnpm exec varlock run -- node .output/server/index.mjs',
      env: { PORT: String(port()), HOST: '127.0.0.1' },
      readyPattern: /Listening on/,
      readyTimeout: 300_000,
      timeout: 420_000,
      templateFiles: {
        'server/api/leak.get.ts': 'routes/leaky-endpoint.ts',
      },
      requests: [
        {
          path: '/api/leak',
          // the patched response throws instead of writing the body, so the
          // request never completes - only the absence of the secret matters
          allowRequestFailure: true,
          bodyAssertions: {
            shouldNotContain: ['super-secret-value'],
          },
        },
      ],
      outputAssertions: [
        {
          description: 'server reports the leak',
          shouldContain: ['DETECTED LEAKED SENSITIVE CONFIG'],
        },
      ],
    });
  });
}
