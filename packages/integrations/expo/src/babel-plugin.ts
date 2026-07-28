import { execSyncVarlock, VarlockExecError } from 'varlock/exec-sync-varlock';
import { initVarlockEnv } from 'varlock/env';
import { patchGlobalConsole } from 'varlock/patch-console';
import { createDebug, type SerializedEnvGraph } from 'varlock';

const debug = createDebug('varlock:expo-integration');

// need to track original process.env, since we will be modifying it
const originalProcessEnv = { ...process.env };

let varlockLoadedEnv: SerializedEnvGraph | undefined;
let configIsValid = true;

function loadVarlockConfig() {
  debug('loading varlock config for expo babel plugin');
  try {
    const { stdout } = execSyncVarlock('load --format json-full', {
      fullResult: true,
      env: originalProcessEnv,
      integrationTelemetry: {
        name: __VARLOCK_INTEGRATION_NAME__,
        version: __VARLOCK_INTEGRATION_VERSION__,
      },
    });
    process.env.__VARLOCK_ENV = stdout;
    varlockLoadedEnv = JSON.parse(stdout) as SerializedEnvGraph;
    configIsValid = true;

    // Make the loaded env available on globalThis so that any module instance
    // of varlock/env (including Metro's SSR bundle) can pick it up during
    // lazy/auto initialization.
    // No encryption needed here — Expo's Metro process is both build and runtime.
    (globalThis as any).__varlockLoadedEnv = varlockLoadedEnv;

    // initialize varlock and patch globals as necessary
    initVarlockEnv();
    // this will be a no-op if disabled by settings
    patchGlobalConsole();
  } catch (err) {
    if (err instanceof VarlockExecError && err.stderr) {
      process.stderr.write(err.stderr);
    }
    configIsValid = false;
  }
}

// Load immediately when this module is first required/imported
loadVarlockConfig();

type BabelAPI = {
  cache: (fn: boolean | (() => boolean)) => void;
  types: {
    nullLiteral: () => object;
    identifier: (name: string) => object;
    booleanLiteral: (value: boolean) => object;
    numericLiteral: (value: number) => object;
    stringLiteral: (value: string) => object;
    callExpression: (callee: object, args: Array<object>) => object;
    memberExpression: (object: object, property: object, computed?: boolean) => object;
  };
};

type BabelNodePath = {
  node: {
    object: { type: string; name: string };
    property: { type: string; name: string };
    computed: boolean;
  };
  replaceWith: (node: object) => void;
};

type BabelState = {
  filename?: string;
};

/** Expo Router convention: server-only files contain `+api` in the filename. */
function isServerFile(filename?: string): boolean {
  if (!filename) return false;
  return /\+api\./.test(filename);
}

function valueToNode(t: BabelAPI['types'], value: unknown): object {
  if (value === null) return t.nullLiteral();
  if (value === undefined) return t.identifier('undefined');
  if (typeof value === 'boolean') return t.booleanLiteral(value);
  if (typeof value === 'number') return t.numericLiteral(value);
  if (typeof value === 'string') return t.stringLiteral(value);
  // For objects/arrays, use JSON.parse() at runtime to avoid constructing
  // complex nested AST nodes manually
  return t.callExpression(
    t.memberExpression(t.identifier('JSON'), t.identifier('parse')),
    [t.stringLiteral(JSON.stringify(value))],
  );
}

/**
 * Babel plugin for Expo/React Native projects that integrates varlock.
 *
 * Replaces `ENV.xxx` member expressions with their static values at compile time
 * for non-dynamic config items. Dynamic items are NOT inlined and are only
 * accessible at runtime in Expo server routes (+api files) via the ENV proxy.
 * Accessing a sensitive value in native code will emit a build-time warning.
 *
 * @example
 * // babel.config.js
 * module.exports = {
 *   presets: ['babel-preset-expo'],
 *   plugins: [
 *     require('@varlock/expo-integration/babel-plugin'),
 *   ],
 * };
 */
export default function varlockExpoBabelPlugin(api: BabelAPI) {
  // Don't cache since env config can change between runs
  api.cache(false);

  if (!configIsValid || !varlockLoadedEnv) {
    throw new Error(
      '@varlock/expo-integration: Failed to load varlock config.\n'
      + 'Your .env.schema may have syntax errors or failing validation.\n'
      + 'Check the terminal output above for details.',
    );
  }

  const { config } = varlockLoadedEnv;
  const t = api.types;

  // Build the set of non-dynamic keys that can be statically replaced
  const warnedKeys = new Set<string>();
  const staticKeys = new Set<string>();
  for (const itemKey in config) {
    const item = config[itemKey];
    const isDynamic = item.isDynamic ?? item.isSensitive;
    if (!isDynamic) {
      staticKeys.add(itemKey);
    }
  }

  debug('static replacements keys', [...staticKeys]);

  return {
    name: 'varlock-expo-integration',
    visitor: {
      MemberExpression(nodePath: BabelNodePath, state: BabelState) {
        const { node } = nodePath;

        // Match `ENV.xxx` (where ENV is a simple identifier, not computed)
        if (
          node.object.type === 'Identifier'
          && node.object.name === 'ENV'
          && node.property.type === 'Identifier'
          && !node.computed
        ) {
          const key = node.property.name as string;

          if (staticKeys.has(key)) {
            const item = config[key];
            nodePath.replaceWith(valueToNode(t, item.value));
            debug(`replaced ENV.${key} with static value`);
          } else if (config[key]) {
            const isDynamic = config[key].isDynamic ?? config[key].isSensitive;
            if (!isDynamic) return;
            debug(`ENV.${key} is dynamic - skipping static replacement`);

            // any non-inlined (dynamic) value is unavailable in native code - warn either
            // way, leading with the reason that applies (secrecy vs runtime-resolution)
            if (!isServerFile(state.filename) && !warnedKeys.has(key)) {
              warnedKeys.add(key);
              const reason = config[key].isSensitive
                ? `ENV.${key} is marked @sensitive and was not inlined.`
                : `ENV.${key} is dynamic (runtime-resolved) and was not inlined.`;
              const availability = config[key].isSensitive
                ? '  Sensitive values are only accessible in Expo server routes (+api files).'
                : '  Dynamic values are only accessible in Expo server routes (+api files).';
              // eslint-disable-next-line no-console
              console.warn([
                `⚠️  @varlock/expo-integration: ${reason}`,
                `  → ${state.filename ?? '<unknown file>'}`,
                availability,
                '  Accessing this value in native code will throw at runtime.',
              ].join('\n'));
            }
          }
          // If the key doesn't exist in config at all, leave it as-is.
          // Runtime code will throw if __varlockThrowOnMissingKeys is set.
        }
      },
    },
  };
}
