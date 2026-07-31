import ansis from 'ansis';
import { define } from 'gunshi';

import { loadVarlockEnvGraph } from '../../lib/load-graph';
import { checkForSchemaErrors } from '../helpers/error-checks';
import { CliExitError } from '../helpers/exit-error';
import { openUrl } from '../helpers/open-url';
import { keyPressed } from '../helpers/key-press';
import { trackCommand } from '../helpers/telemetry';
import { logLines } from '../helpers/pretty-format';
import { runDeviceCodeLogin, runPkceLogin, OauthLoginError } from '../../lib/oauth-login';
import {
  buildOauthProviderCacheKey, formatOauthScopesForDisplay,
  type OauthProviderCacheEntry,
} from '../../lib/oauth';
import { TTL_FOREVER } from '../../lib/cache/ttl-parser';
import { InMemoryCacheStore } from '../../lib/cache';
import { formatTimeAgo } from '../../lib/formatting';
import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';
import type { OauthProviderInstanceRecord } from '../../env-graph';

const PATH_ARG = {
  type: 'string',
  short: 'p',
  multiple: true,
  description: 'Path to a specific .env file or directory (with trailing slash) to use as the entry point (can be specified multiple times)',
} as const;

async function loadGraphWithProviders(paths?: Array<string>) {
  const envGraph = await loadVarlockEnvGraph({ entryFilePaths: paths });
  checkForSchemaErrors(envGraph);
  if (!Object.keys(envGraph.oauthProviders).length) {
    throw new CliExitError('No oauth providers are defined in your schema', {
      suggestion: 'Define one with a root decorator, e.g. `# @oauthProvider(id=google, preset=google, clientId=$GOOGLE_CLIENT_ID, clientSecret=$GOOGLE_CLIENT_SECRET)`',
    });
  }
  return envGraph;
}

function requirePersistentStore(envGraph: Awaited<ReturnType<typeof loadVarlockEnvGraph>>) {
  const store = envGraph._cacheStore;
  if (!store || store instanceof InMemoryCacheStore) {
    throw new CliExitError('oauth login requires a persistent (disk) cache to store the refresh token', {
      suggestion: 'Caching is currently disabled or memory-only. Remove --skip-cache / @cache=off|memory, and make sure local encryption is set up (see `varlock cache status`).',
    });
  }
  return store;
}

function pickProvider(
  envGraph: Awaited<ReturnType<typeof loadVarlockEnvGraph>>,
  requestedId: string | undefined,
): OauthProviderInstanceRecord {
  const providers = envGraph.oauthProviders;
  const ids = Object.keys(providers);
  if (requestedId) {
    const record = providers[requestedId];
    if (!record) {
      throw new CliExitError(`Unknown oauth provider "${requestedId}"`, {
        suggestion: `Defined providers: ${ids.join(', ')}`,
      });
    }
    return record;
  }
  if (ids.length === 1) return providers[ids[0]];
  throw new CliExitError('Multiple oauth providers are defined - specify which one to log in to', {
    suggestion: `e.g. \`varlock oauth login ${ids[0]}\` (defined providers: ${ids.join(', ')})`,
  });
}

/** union of provider-level scopes, preset-required scopes, and every login-provisioned item's scopes */
async function collectLoginScopes(
  envGraph: Awaited<ReturnType<typeof loadVarlockEnvGraph>>,
  record: OauthProviderInstanceRecord,
): Promise<string | undefined> {
  const delim = record.scopesDelimiter;
  const scopeSet = new Set<string>();
  const addScopes = (val: unknown) => {
    if (typeof val === 'string') {
      val.split(delim).map((s) => s.trim()).filter(Boolean).forEach((s) => scopeSet.add(s));
    } else if (Array.isArray(val)) {
      val.forEach((s) => typeof s === 'string' && s && scopeSet.add(s));
    }
  };

  addScopes(record.resolved?.scope);
  record.requiredLoginScopes.forEach((s) => scopeSet.add(s));

  for (const usage of record.usedBy) {
    // items with their own refresh token (or a non-refresh grant) don't consume the login-provisioned token
    if (usage.hasOwnRefreshToken || usage.grantType !== 'refresh_token' || !usage.scopesResolver) continue;
    for (const depKey of usage.scopesResolver.deps) {
      await envGraph.resolveItemWithDeps(depKey);
    }
    addScopes(await usage.scopesResolver.resolve());
  }

  return scopeSet.size ? [...scopeSet].join(delim) : undefined;
}

// --- `varlock oauth login` --------------------------------------------------

const loginCommand = define({
  name: 'login',
  description: 'Run a browser login flow and store the resulting refresh token in the encrypted cache',
  args: {
    provider: {
      type: 'positional',
      required: false,
      description: 'The @oauthProvider id to log in to (optional when only one is defined)',
    },
    flow: {
      type: 'string',
      description: 'Login flow to use: "device" (enter a code) or "browser" (loopback redirect). Defaults to device when the provider supports it.',
    },
    scopes: {
      type: 'string',
      description: 'Override the scopes to request (defaults to the union of scopes used in your schema)',
    },
    path: PATH_ARG,
  },
  examples: `
  varlock oauth login                    # log in (single provider defined)
  varlock oauth login google             # log in to a specific provider
  varlock oauth login google --flow browser
  varlock oauth login google --scopes "scope-a scope-b"
`.trim(),
  run: async (ctx) => {
    await trackCommand('oauth login', { command: 'oauth login' });

    const envGraph = await loadGraphWithProviders(ctx.values.path);
    const store = requirePersistentStore(envGraph);
    const record = pickProvider(envGraph, ctx.values.provider);
    if (!record.resolved) {
      throw new CliExitError(`oauth provider "${record.id}" failed to initialize - fix schema errors first`);
    }

    const scope = ctx.values.scopes ?? await collectLoginScopes(envGraph, record);

    let flow = ctx.values.flow;
    if (flow && flow !== 'device' && flow !== 'browser') {
      throw new CliExitError('--flow must be "device" or "browser"');
    }
    flow ||= record.deviceAuthorizationUrl ? 'device' : 'browser';
    if (flow === 'device' && !record.deviceAuthorizationUrl) {
      throw new CliExitError(`Provider "${record.id}" has no device authorization endpoint`, {
        suggestion: 'Use --flow browser, or set deviceAuthorizationUrl on the @oauthProvider',
      });
    }
    if (flow === 'browser' && !record.authorizationUrl) {
      throw new CliExitError(`Provider "${record.id}" has no authorization endpoint configured`, {
        suggestion: [
          'Set authorizationUrl on the @oauthProvider (or use a preset that provides one)',
          ...record.notes ? [`Note for this provider: ${record.notes}`] : [],
        ].join('\n'),
      });
    }

    // state intent up front so the terminal can be compared against the provider's consent screen
    logLines([
      `🔑 Logging in to oauth provider ${ansis.bold(record.id)}`,
      '',
      `  token endpoint: ${record.tokenUrl}`,
      `  client id:      ${record.resolved.clientId}`,
      `  scopes:         ${formatOauthScopesForDisplay(scope)}`,
      '',
    ]);

    const loginConfig = {
      tokenUrl: record.tokenUrl,
      authorizationUrl: record.authorizationUrl,
      deviceAuthorizationUrl: record.deviceAuthorizationUrl,
      clientId: record.resolved.clientId,
      clientSecret: record.resolved.clientSecret,
      clientAuth: record.clientAuth,
      scope,
      extraAuthParams: record.extraAuthParams,
    };

    let loginResult;
    try {
      if (flow === 'device') {
        loginResult = await runDeviceCodeLogin(loginConfig, {
          onUserCode: async (info) => {
            logLines([
              `First please copy this code: ${ansis.bold.magenta(info.userCode)}`,
              '',
              `Then log in @ ${info.verificationUri}`,
            ]);
            if (process.stdin.isTTY) {
              console.log('\nPress ENTER to open in your default browser...');
              await keyPressed(['\r']);
              openUrl(info.verificationUriComplete ?? info.verificationUri);
            }
            console.log(ansis.italic.gray('... waiting for you to complete login ...'));
          },
        });
      } else {
        loginResult = await runPkceLogin(loginConfig, {
          onAuthorizationUrl: async (url) => {
            logLines([
              'Complete the login in your browser:',
              '',
              ansis.cyan(url),
            ]);
            openUrl(url);
            console.log(ansis.italic.gray('... waiting for you to complete login ...'));
          },
        });
      }
    } catch (err) {
      if (err instanceof OauthLoginError) {
        throw new CliExitError(`Login failed: ${err.message}`, err.tip ? { suggestion: err.tip } : undefined);
      }
      throw err;
    }

    const providerCacheKey = buildOauthProviderCacheKey({
      tokenUrl: record.tokenUrl,
      clientId: record.resolved.clientId,
    });
    const entry: OauthProviderCacheEntry = {
      refreshToken: loginResult.refreshToken,
      grantedScope: loginResult.grantedScope ?? scope,
      updatedAt: Date.now(),
      source: 'login',
    };
    const stored = await store.set(providerCacheKey, entry, TTL_FOREVER);
    if (!stored) {
      throw new CliExitError('Login succeeded but the refresh token could not be written to the cache', {
        suggestion: 'Check `varlock cache status` - local encryption may not be set up',
      });
    }

    logLines([
      '',
      `✅ Logged in to ${ansis.bold(record.id)} - refresh token stored in the encrypted cache`,
      ...loginResult.grantedScope ? [ansis.gray(`   granted scopes: ${formatOauthScopesForDisplay(loginResult.grantedScope)}`)] : [],
      '',
      `Items using ${ansis.cyan(`oauth(${record.id === '_default' ? '' : record.id}...)`)} without an explicit refreshToken will now resolve.`,
    ]);
  },
});

// --- `varlock oauth status` ---------------------------------------------------

const statusCommand = define({
  name: 'status',
  description: 'Show defined oauth providers and whether a refresh token has been provisioned',
  args: {
    path: PATH_ARG,
  },
  run: async (ctx) => {
    await trackCommand('oauth status', { command: 'oauth status' });
    const envGraph = await loadGraphWithProviders(ctx.values.path);
    const store = envGraph._cacheStore;

    for (const record of Object.values(envGraph.oauthProviders)) {
      console.log(`${ansis.bold(record.id)}${record.presetName ? ansis.gray(` (preset: ${record.presetName})`) : ''}`);
      console.log(ansis.gray(`  token endpoint: ${record.tokenUrl}`));
      const loginConsumers = record.usedBy.filter((u) => !u.hasOwnRefreshToken && u.grantType === 'refresh_token');
      if (record.usedBy.length) {
        console.log(ansis.gray(`  used by: ${record.usedBy.map((u) => u.itemKey).join(', ')}`));
      }

      if (!record.resolved) {
        console.log(ansis.red('  ⚠️ failed to initialize'));
      } else if (store && !(store instanceof InMemoryCacheStore)) {
        const providerCacheKey = buildOauthProviderCacheKey({
          tokenUrl: record.tokenUrl,
          clientId: record.resolved.clientId,
        });
        const cached = await store.get(providerCacheKey);
        const entry = cached?.value as OauthProviderCacheEntry | undefined;
        if (entry?.refreshToken) {
          const sourceLabel = entry.source === 'login' ? 'via login' : 'rotated';
          console.log(`  ✅ refresh token provisioned ${ansis.gray(`(${sourceLabel}, updated ${formatTimeAgo(entry.updatedAt)})`)}`);
          if (entry.grantedScope) console.log(ansis.gray(`     scopes: ${formatOauthScopesForDisplay(entry.grantedScope)}`));
        } else if (loginConsumers.length) {
          console.log(`  ❌ no refresh token provisioned - run ${ansis.cyan(`varlock oauth login ${record.id === '_default' ? '' : record.id}`.trim())}`);
        } else {
          console.log(ansis.gray('  no login-provisioned token needed (items pass refreshToken explicitly)'));
        }
      } else {
        console.log(ansis.gray('  cache is disabled or memory-only - login provisioning unavailable'));
      }
      console.log('');
    }
  },
});

// --- `varlock oauth` (parent) -------------------------------------------------

export const commandSpec = define({
  name: 'oauth',
  description: 'Manage OAuth providers and login-provisioned refresh tokens',
  subCommands: {
    login: loginCommand,
    status: statusCommand,
  },
  examples: `
Provision and inspect refresh tokens for @oauthProvider instances used by oauth().

Examples:
  varlock oauth status                   # show providers and provisioning state
  varlock oauth login                    # run the login flow (single provider defined)
  varlock oauth login google             # log in to a specific provider
`.trim(),
});

/** bare `varlock oauth` behaves like `varlock oauth status` */
export const commandFn: TypedGunshiCommandFn<typeof commandSpec> = async (ctx) => {
  await statusCommand.run!(ctx as any);
};
