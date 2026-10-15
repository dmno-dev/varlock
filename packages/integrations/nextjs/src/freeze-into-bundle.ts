/* eslint-disable no-console */

/**
 * Freezing the env into the bundle (the bundle route): whether a production build bakes a
 * frozen env into its server runtime files, and what that frozen env is.
 *
 * A build either freezes (the env is resolved and validated once, here, and the server boots
 * from exactly that) or it does not (the server resolves at boot, through the varlock CLI or
 * `varlock run`, which can itself boot from a `varlock freeze` file). The decision is made at
 * build and never at boot, so one key never has two possible sources depending on what the
 * server finds when it starts.
 *
 * `freezeIntoBundle: 'auto'` freezes only on platforms where varlock cannot resolve at request
 * time (no CLI, no .env files, no `varlock run` in front of the server). Everything else, such
 * as `next start` or `output: 'standalone'`, resolves at boot.
 */

import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { SerializedEnvGraph } from 'varlock';
import { encryptEnvBlobSync } from 'varlock/encrypt-env';

export type FreezeIntoBundleOption = boolean | 'auto';

export type FreezeDecision = {
  frozen: boolean,
  /** why, for the build announcement */
  reason: string,
  /** the platform `auto` detected, if any (also used to warn when `false` is set on one) */
  platform?: string,
};

/**
 * next config `env` key carrying a frozen build's frozen env (encrypted), recorded by Next in
 * the build output (`required-server-files.json`, and the standalone server's config). At boot
 * the server reads it back from there before anything else runs (see next-env-compat), so even
 * code outside the bundle, like `next.config` under `next start`, sees the frozen env. Never
 * referenced as `process.env.<key>`, so no bundler inlines it anywhere.
 */
export const FROZEN_BUILD_ENV_KEY = '_VARLOCK_FROZEN_BUNDLE_ENV';

/** carries the build's decision to Next's build workers, which re-evaluate the config */
const DECISION_ENV_KEY = '__VARLOCK_NEXT_FREEZE_DECISION';

/** opt out of encrypting a frozen bundle */
export const ALLOW_PLAINTEXT_ENV_KEY = '_VARLOCK_ALLOW_PLAINTEXT_FROZEN_ENV';

function debug(...args: Array<any>) {
  if (!process.env.DEBUG_VARLOCK_NEXT_INTEGRATION) return;
  console.log('[varlock] freeze --', ...args);
}

/**
 * Whether an ancestor process is an OpenNext build (`opennextjs-cloudflare build`,
 * `open-next build`, ...), which runs `next build` as a child. Its output runs on platforms
 * with no varlock CLI at request time.
 */
function isOpenNextBuild(): boolean {
  if (process.platform === 'win32') return false;
  try {
    let pid = process.ppid;
    for (let depth = 0; depth < 6 && pid > 1; depth++) {
      const out = execSync(`ps -o ppid= -o command= -p ${pid}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      if (!out) break;
      const [, ppidStr, command] = out.match(/^(\d+)\s+(.*)$/) || [];
      if (/(^|[\\/\s])(open-next|opennextjs-[\w-]+)(\s|$)/.test(command || '')) return true;
      pid = parseInt(ppidStr, 10);
    }
  } catch {
    // no `ps`, or the process tree is not readable - not detected
  }
  return false;
}

/** A platform where varlock cannot resolve the env at request time, if this build is for one */
function detectNoRuntimeLoaderPlatform(): string | undefined {
  if (process.env.VERCEL === '1') return 'Vercel';
  if (process.env.NETLIFY === 'true') return 'Netlify';
  if (process.env.WORKERS_CI === '1') return 'Cloudflare Workers Builds';
  if (isOpenNextBuild()) return 'OpenNext';
  return undefined;
}

let decision: FreezeDecision | undefined;

/**
 * Decide, once per build, whether to freeze the env into the bundle. The main build process
 * decides and hands the decision to the build workers through the environment, so platform
 * detection runs once and every process agrees.
 */
export function decideFreezeIntoBundle(option: FreezeIntoBundleOption = 'auto'): FreezeDecision {
  if (decision) return decision;

  const inherited = process.env[DECISION_ENV_KEY];
  if (inherited) {
    try {
      decision = JSON.parse(inherited) as FreezeDecision;
      return decision;
    } catch { /* decide again */ }
  }

  if (option !== true && option !== false && option !== 'auto') {
    throw new Error(`[varlock] freezeIntoBundle must be true, false, or 'auto' (got ${JSON.stringify(option)})`);
  }

  const platform = option === 'auto' ? detectNoRuntimeLoaderPlatform() : undefined;
  if (option === true) {
    decision = { frozen: true, reason: 'freezeIntoBundle: true' };
  } else if (option === false) {
    decision = { frozen: false, reason: 'freezeIntoBundle: false', platform: detectNoRuntimeLoaderPlatform() };
  } else if (platform) {
    decision = { frozen: true, reason: `${platform}: varlock cannot resolve the env at request time there`, platform };
  } else {
    decision = { frozen: false, reason: 'no platform without a runtime loader detected' };
  }
  process.env[DECISION_ENV_KEY] = JSON.stringify(decision);
  debug('decision', decision);
  return decision;
}

/** The decision made earlier in this build, if any */
export function getFreezeDecision(): FreezeDecision | undefined {
  return decision;
}

type FrozenBundlePayload = {
  /** what gets baked in: encrypted, or plaintext JSON when allowed */
  payload: string,
  /**
   * id unique to this frozen env, visible inside the plaintext payload, so a runtime prelude
   * can tell its own payload (already decrypted into process.env by an earlier prelude, or
   * inherited by the edge sandbox) from a different env supplied at boot
   */
  freezeId: string,
  bootKeys: Array<string>,
  encrypted: boolean,
};

let frozenPayload: FrozenBundlePayload | undefined;

/**
 * The frozen env to bake into the bundle, built from the graph the build already resolved (so
 * static replacements and the frozen env come from the same resolution). Same policy as
 * `varlock freeze`: a graph with errors is refused, override provenance is cleared (there is no
 * parent invocation to re-apply it), and it must be encrypted unless explicitly allowed.
 */
export function getFrozenBundlePayload(): FrozenBundlePayload {
  if (frozenPayload) return frozenPayload;

  const rawEnv = process.env.__VARLOCK_ENV;
  if (!rawEnv) throw new Error('[varlock] cannot freeze the env into the bundle: no resolved env found in the build');
  const graph = JSON.parse(rawEnv) as SerializedEnvGraph & { freezeId?: string };
  if (graph.errors) {
    throw new Error('[varlock] cannot freeze the env into the bundle: it failed to resolve (see the errors above)');
  }

  const encryptionKey = process.env._VARLOCK_ENV_KEY;
  const allowPlaintext = ['1', 'true'].includes(String(process.env[ALLOW_PLAINTEXT_ENV_KEY]).toLowerCase());
  if (!encryptionKey && !allowPlaintext) {
    throw new Error([
      '[varlock] _VARLOCK_ENV_KEY is not set, so the env frozen into this build cannot be encrypted.',
      'Generate a key with `varlock generate-key` and set it both in the build environment and at runtime',
      `(see https://varlock.dev/guides/encrypted-deployments/). Set ${ALLOW_PLAINTEXT_ENV_KEY}=1 only if you`,
      'accept every resolved secret sitting unencrypted inside your build output.',
    ].join('\n'));
  }

  // derived from the resolved env, so Next's build workers (each building its own payload)
  // agree on it
  const freezeId = createHash('sha256').update(rawEnv).digest('hex').slice(0, 16);
  delete graph.injectedAtBuild;
  graph.frozen = true;
  graph.overrideKeys = [];
  graph.freezeId = freezeId;
  const json = JSON.stringify(graph);

  frozenPayload = {
    payload: encryptionKey ? encryptEnvBlobSync(json, encryptionKey) : json,
    freezeId,
    bootKeys: Object.keys(graph.config).filter((key) => graph.config[key].boot),
    encrypted: !!encryptionKey,
  };
  return frozenPayload;
}

/** Print the decision once per build (frozen builds only: resolving at boot is the default) */
export function announceFreezeDecision(freeze: FreezeDecision) {
  if (process.env.__VARLOCK_NEXT_FREEZE_ANNOUNCED) return;
  process.env.__VARLOCK_NEXT_FREEZE_ANNOUNCED = '1';

  if (!freeze.frozen) {
    if (freeze.platform) {
      console.warn([
        `[varlock] ⚠️ freezeIntoBundle is false, but this looks like a ${freeze.platform} build, where varlock cannot`,
        '  resolve the env at request time. The server will fail to boot unless the varlock CLI is available there.',
      ].join('\n'));
    }
    return;
  }

  const { bootKeys, encrypted } = getFrozenBundlePayload();
  console.log(`[varlock] env frozen into the bundle (${freeze.reason})`);
  if (bootKeys.length) console.log(`  can be set at boot (@dynamic=boot): ${bootKeys.join(', ')}`);
  console.log(`  ${encrypted ? 'encrypted with _VARLOCK_ENV_KEY' : 'UNENCRYPTED'}`);
}

export const NOT_FROZEN_BOOT_HINT = [
  '',
  '🚨 [varlock] no resolved env reached this Next.js server 🚨',
  'This build was not frozen, so the env is resolved when the server boots. Either:',
  '  - make the varlock CLI available at boot (`output: \'standalone\'` does not include it), or',
  '  - boot via `varlock run -- <command>` (add `--frozen` to boot from a `varlock freeze` file), or',
  '  - freeze the env into the build: varlockNextConfigPlugin({ freezeIntoBundle: true })',
  'See https://varlock.dev/integrations/nextjs/#freezing-the-env-into-the-build',
  '',
].join('\n');

/**
 * Raw JS to prepend to a server/edge runtime file, ahead of the varlock init bundle.
 *
 * Frozen: sets the frozen env outright (it wins over any `__VARLOCK_ENV` in the environment,
 * which gets a warning unless it is this same env coming back), and prepends the boot-value
 * bundle when the frozen env has `@dynamic=boot` items.
 *
 * Not frozen: bakes nothing; prints how to fix it when no resolved env reached the server
 * (initVarlockEnv then fails with its own error).
 */
export function getRuntimePrelude(): string {
  const freeze = getFreezeDecision();
  if (!freeze?.frozen) {
    return `if (!process.env.__VARLOCK_ENV && !globalThis.__varlockLoadedEnv) console.error(${JSON.stringify(NOT_FROZEN_BOOT_HINT)});`;
  }

  const { payload, freezeId, bootKeys } = getFrozenBundlePayload();
  const lines = [
    '(function(){',
    `var p=${JSON.stringify(payload)};`,
    'var a=process.env.__VARLOCK_ENV;',
    // this same frozen env, already decrypted: by the server process at boot (see
    // next-env-compat), or by an earlier runtime file. An edge sandbox inherits it from the
    // server process, which spares it an asynchronous decrypt.
    `if (a && a.indexOf(${JSON.stringify(`"freezeId":"${freezeId}"`)}) !== -1) return;`,
    // during the build itself, prerendering carries the build's own resolution
    'if (a && a !== p && !process.env.__VARLOCK_NEXT_BUILD && !globalThis.__varlockFrozenBundle) {',
    '  console.warn("[varlock] ⚠️ this build has its env frozen into the bundle, so the __VARLOCK_ENV set in the environment is ignored.");',
    '}',
    'globalThis.__varlockFrozenBundle = true;',
    'process.env.__VARLOCK_ENV = p;',
    '})();',
  ];
  if (bootKeys.length) {
    const bootSrc = fs.readFileSync(require.resolve('varlock/frozen-env-boot'), 'utf8');
    lines.push(`(function(exports,module){${bootSrc}})({},{exports:{}});`);
  }
  return lines.join('\n');
}
