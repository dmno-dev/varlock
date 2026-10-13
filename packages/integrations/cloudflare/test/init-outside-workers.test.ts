/*
`@varlock/cloudflare-integration/init` must also load in plain Node, where frameworks
(e.g. Nitro 3) evaluate the server bundle to prerender. There `cloudflare:workers` can't
be imported, so init reads the same keys from process.env.

Runs the built `dist/init.mjs` in a child Node process: the module initializes at import
time, and Node's own ESM loader is what rejects the `cloudflare:` scheme.
*/
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  describe, it, expect, beforeAll,
} from 'vitest';
import { encryptEnvBlobSync, generateEncryptionKeyHex } from 'varlock/encrypt-env';

const initPath = path.resolve(import.meta.dirname, '../dist/init.mjs');

const serializedEnv = JSON.stringify({
  sources: [],
  settings: {},
  config: {
    PUBLIC_VAR: { value: 'public-value', isSensitive: false },
    SECRET_VAR: { value: 'secret-value', isSensitive: true },
  },
});

function runInit(env: Record<string, string>) {
  const script = `
    const { ENV } = await import(${JSON.stringify(initPath)});
    // init patches console redaction, so report the secret's length rather than its value
    console.log(JSON.stringify({ PUBLIC_VAR: ENV.PUBLIC_VAR, SECRET_VAR_LENGTH: ENV.SECRET_VAR?.length }));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    // pass env explicitly so nothing from the test runner's env leaks in
    env: { PATH: process.env.PATH ?? '', ...env },
    encoding: 'utf8',
  });
  return JSON.parse(out.trim().split('\n').at(-1)!);
}

describe('init outside Workers (Node)', () => {
  beforeAll(() => {
    if (!existsSync(initPath)) throw new Error(`${initPath} not found - build the package first`);
  });

  it('loads a plain __VARLOCK_ENV blob from process.env', () => {
    expect(runInit({ __VARLOCK_ENV: serializedEnv })).toEqual({
      PUBLIC_VAR: 'public-value',
      SECRET_VAR_LENGTH: 'secret-value'.length,
    });
  });

  it('joins a chunked blob from process.env', () => {
    const mid = Math.floor(serializedEnv.length / 2);
    expect(runInit({
      __VARLOCK_ENV_CHUNKS: '2',
      __VARLOCK_ENV_0: serializedEnv.slice(0, mid),
      __VARLOCK_ENV_1: serializedEnv.slice(mid),
    })).toEqual({
      PUBLIC_VAR: 'public-value',
      SECRET_VAR_LENGTH: 'secret-value'.length,
    });
  });

  it('decrypts an encrypted blob with _VARLOCK_ENV_KEY from process.env', () => {
    const key = generateEncryptionKeyHex();
    expect(runInit({
      __VARLOCK_ENV: encryptEnvBlobSync(serializedEnv, key),
      _VARLOCK_ENV_KEY: key,
    })).toEqual({
      PUBLIC_VAR: 'public-value',
      SECRET_VAR_LENGTH: 'secret-value'.length,
    });
  });
});
