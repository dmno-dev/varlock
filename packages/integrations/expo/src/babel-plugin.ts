import { execSyncVarlock } from 'varlock/exec-sync-varlock';
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
    const execResult = execSyncVarlock('load --format json-full', {
      env: originalProcessEnv,
      showLogsOnError: true,
    });
    process.env.__VARLOCK_ENV = execResult;
    varlockLoadedEnv = JSON.parse(process.env.__VARLOCK_ENV) as SerializedEnvGraph;
    configIsValid = true;

    // Make the loaded env available on globalThis so that any module instance
    // of varlock/env (including Metro's SSR bundle) can pick it up during
    // lazy/auto initialization.
    (globalThis as any).__varlockLoadedEnv = varlockLoadedEnv;

    // initialize varlock and patch globals as necessary
    initVarlockEnv();
    // this will be a no-op if disabled by settings
    patchGlobalConsole();
  } catch (_err) {
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
 * for non-sensitive config items. Sensitive items are NOT inlined and are only
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

  // Build the set of non-sensitive keys that can be statically replaced
  const warnedSensitiveKeys = new Set<string>();
  const nonSensitiveKeys = new Set<string>();
  for (const itemKey in config) {
    if (!config[itemKey].isSensitive) {
      nonSensitiveKeys.add(itemKey);
    }
  }

  debug('static replacements keys', [...nonSensitiveKeys]);

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

          if (nonSensitiveKeys.has(key)) {
            const item = config[key];
            nodePath.replaceWith(valueToNode(t, item.value));
            debug(`replaced ENV.${key} with static value`);
          } else if (config[key]?.isSensitive) {
            debug(`ENV.${key} is sensitive - skipping static replacement`);

            if (!isServerFile(state.filename) && !warnedSensitiveKeys.has(key)) {
              warnedSensitiveKeys.add(key);
              // eslint-disable-next-line no-console
              console.warn([
                `⚠️  @varlock/expo-integration: ENV.${key} is marked @sensitive and was not inlined.`,
                `  → ${state.filename ?? '<unknown file>'}`,
                '  Sensitive values are only accessible in Expo server routes (+api files).',
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
