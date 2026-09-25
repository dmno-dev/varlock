import {
  describe, test, expect, beforeEach, afterEach,
} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  FROZEN_ENV_FILE_NAME,
  FrozenEnvFileError,
  USE_FROZEN_ENV_VAR,
  getFrozenEnvFileInPlay,
  readFrozenEnvFile,
  resolveFrozenEnvFileMode,
} from '../frozen-env-file';
import { evaluateInjectedEnvReuse, findPinnedGraphForResolution, USE_INJECTED_ENV_VAR } from '../injected-env-reuse';
import { encryptEnvBlobSync, generateEncryptionKeyHex } from '../../runtime/crypto';

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-frozen-env-'));
  // realpath so assertions aren't confused by symlinked tmp dirs (e.g. /tmp on macOS)
  tempDir = fs.realpathSync(tempDir);
});

afterEach(() => {
  if (tempDir && fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function graphJson(overrides?: Record<string, any>) {
  return JSON.stringify({
    basePath: tempDir,
    sources: [],
    settings: {},
    config: {
      FOO: { value: 'foo-val', isSensitive: false },
      SECRET: { value: 'secret-val', isSensitive: true },
    },
    overrideKeys: [],
    ...overrides,
  });
}

/** write a frozen env file, encrypted unless `key` is null */
function writeFrozenFile(opts?: { key?: string | null, contents?: string, fileName?: string }) {
  const key = opts?.key === undefined ? generateEncryptionKeyHex() : opts.key;
  const json = opts?.contents ?? graphJson();
  const filePath = path.join(tempDir, opts?.fileName ?? FROZEN_ENV_FILE_NAME);
  fs.writeFileSync(filePath, `${key ? encryptEnvBlobSync(json, key) : json}\n`);
  return { filePath, key };
}

describe('resolveFrozenEnvFileMode', () => {
  test('defaults to auto at the default path', () => {
    expect(resolveFrozenEnvFileMode({}, tempDir)).toEqual({
      mode: 'auto', filePath: path.join(tempDir, FROZEN_ENV_FILE_NAME),
    });
  });

  test.each(['1', 'true', 'TRUE', ' True '])('%s requires the file at the default path', (rawValue) => {
    expect(resolveFrozenEnvFileMode({ [USE_FROZEN_ENV_VAR]: rawValue }, tempDir)).toEqual({
      mode: 'required', filePath: path.join(tempDir, FROZEN_ENV_FILE_NAME),
    });
  });

  test.each(['0', 'false', 'False'])('%s disables frozen env files', (rawValue) => {
    expect(resolveFrozenEnvFileMode({ [USE_FROZEN_ENV_VAR]: rawValue }, tempDir)).toEqual({ mode: 'off' });
  });

  test('an empty value is treated as unset', () => {
    expect(resolveFrozenEnvFileMode({ [USE_FROZEN_ENV_VAR]: '  ' }, tempDir).mode).toBe('auto');
  });

  test('any other value is a required path, resolved against cwd', () => {
    expect(resolveFrozenEnvFileMode({ [USE_FROZEN_ENV_VAR]: 'dist/env.frozen' }, tempDir)).toEqual({
      mode: 'required', filePath: path.join(tempDir, 'dist/env.frozen'),
    });
  });

  test('absolute paths are used as-is', () => {
    const abs = path.join(tempDir, 'somewhere', 'env.frozen');
    expect(resolveFrozenEnvFileMode({ [USE_FROZEN_ENV_VAR]: abs }, tempDir)).toEqual({
      mode: 'required', filePath: abs,
    });
  });

  // unlike _VARLOCK_USE_INJECTED_ENV (which maps unknown values back to auto), an
  // unrecognized value here is a path - so a typo hard-errors as a missing file rather than
  // silently disabling the pin
  test('a typo`d disable value becomes a required path rather than disabling', () => {
    expect(resolveFrozenEnvFileMode({ [USE_FROZEN_ENV_VAR]: 'off' }, tempDir)).toEqual({
      mode: 'required', filePath: path.join(tempDir, 'off'),
    });
    expect(() => readFrozenEnvFile({ env: { [USE_FROZEN_ENV_VAR]: 'off' }, cwd: tempDir }))
      .toThrow(/requires a frozen env file/);
  });
});

describe('readFrozenEnvFile', () => {
  test('returns not-found when no file is present', () => {
    expect(readFrozenEnvFile({ env: {}, cwd: tempDir })).toMatchObject({
      found: false, reason: expect.stringContaining('no frozen env file'),
    });
  });

  test('reads and decrypts a file at the default path', () => {
    const { key } = writeFrozenFile();
    const result = readFrozenEnvFile({ env: { _VARLOCK_ENV_KEY: key! }, cwd: tempDir });
    expect(result.found).toBe(true);
    if (result.found) expect(JSON.parse(result.blobJson).config.FOO.value).toBe('foo-val');
  });

  test('reads a plaintext file', () => {
    writeFrozenFile({ key: null });
    const result = readFrozenEnvFile({ env: {}, cwd: tempDir });
    expect(result.found).toBe(true);
    if (result.found) expect(JSON.parse(result.blobJson).config.FOO.value).toBe('foo-val');
  });

  test('reads a file at an explicit path', () => {
    const { key } = writeFrozenFile({ fileName: 'custom.frozen' });
    const result = readFrozenEnvFile({
      env: { _VARLOCK_ENV_KEY: key!, [USE_FROZEN_ENV_VAR]: 'custom.frozen' },
      cwd: tempDir,
    });
    expect(result.found).toBe(true);
  });

  test('does not read anything when disabled', () => {
    writeFrozenFile({ key: null });
    expect(readFrozenEnvFile({ env: { [USE_FROZEN_ENV_VAR]: '0' }, cwd: tempDir })).toMatchObject({
      found: false, reason: expect.stringContaining('disabled'),
    });
  });

  test('throws when required but missing', () => {
    expect(() => readFrozenEnvFile({ env: { [USE_FROZEN_ENV_VAR]: '1' }, cwd: tempDir }))
      .toThrow(FrozenEnvFileError);
  });

  describe('fail-closed on a present but unusable file', () => {
    test('throws when encrypted and no key is set', () => {
      writeFrozenFile();
      expect(() => readFrozenEnvFile({ env: {}, cwd: tempDir }))
        .toThrow(/_VARLOCK_ENV_KEY is not set/);
    });

    test('throws when the key is wrong', () => {
      writeFrozenFile();
      expect(() => readFrozenEnvFile({ env: { _VARLOCK_ENV_KEY: generateEncryptionKeyHex() }, cwd: tempDir }))
        .toThrow(/failed to decrypt/);
    });

    test('throws when the file is empty', () => {
      fs.writeFileSync(path.join(tempDir, FROZEN_ENV_FILE_NAME), '\n');
      expect(() => readFrozenEnvFile({ env: {}, cwd: tempDir })).toThrow(/is empty/);
    });

    test('throws when combined with _VARLOCK_FILTER', () => {
      writeFrozenFile({ key: null });
      expect(() => readFrozenEnvFile({ env: { _VARLOCK_FILTER: 'FOO' }, cwd: tempDir }))
        .toThrow(/_VARLOCK_FILTER/);
    });

    // existsSync is true for these too, and reading a FIFO with no writer never returns
    test('throws when the path is a directory', () => {
      fs.mkdirSync(path.join(tempDir, FROZEN_ENV_FILE_NAME));
      expect(() => readFrozenEnvFile({ env: {}, cwd: tempDir })).toThrow(/not a regular file/);
      expect(getFrozenEnvFileInPlay({}, tempDir)).toBe(path.join(tempDir, FROZEN_ENV_FILE_NAME));
    });

    test('throws when the path is a FIFO, without opening it', () => {
      if (process.platform === 'win32') return;
      const fifoPath = path.join(tempDir, FROZEN_ENV_FILE_NAME);
      expect(spawnSync('mkfifo', [fifoPath]).status).toBe(0);
      expect(() => readFrozenEnvFile({ env: {}, cwd: tempDir })).toThrow(/not a regular file/);
    });
  });
});

describe('getFrozenEnvFileInPlay', () => {
  test('undefined when disabled, or when nothing is present in auto mode', () => {
    expect(getFrozenEnvFileInPlay({}, tempDir)).toBeUndefined();
    writeFrozenFile({ key: null });
    expect(getFrozenEnvFileInPlay({ [USE_FROZEN_ENV_VAR]: '0' }, tempDir)).toBeUndefined();
  });

  test('returns the path when present, or when required but missing', () => {
    expect(getFrozenEnvFileInPlay({ [USE_FROZEN_ENV_VAR]: '1' }, tempDir))
      .toBe(path.join(tempDir, FROZEN_ENV_FILE_NAME));
    const { filePath } = writeFrozenFile({ key: null });
    expect(getFrozenEnvFileInPlay({}, tempDir)).toBe(filePath);
  });
});

describe('evaluateInjectedEnvReuse with a frozen env file', () => {
  test('consumes the file with no env files present, and reports its source', () => {
    const { key } = writeFrozenFile();
    const decision = evaluateInjectedEnvReuse({ env: { _VARLOCK_ENV_KEY: key! }, cwd: tempDir });
    expect(decision.reuse).toBe(true);
    if (decision.reuse) {
      expect(decision.source).toBe('frozen-file');
      expect(decision.parsedEnv.config.SECRET.value).toBe('secret-val');
    }
  });

  // the whole point of freezing is that a deploy carries no .env files, so the basePath and
  // source-fingerprint checks that gate automatic blob reuse cannot apply here
  test('is authoritative even when resolved in a different directory', () => {
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-other-'));
    try {
      const { key } = writeFrozenFile({
        contents: graphJson({
          basePath: otherDir,
          sources: [
            {
              type: 'file', label: '.env', enabled: true, path: '.env',
            },
          ],
        }),
      });
      const decision = evaluateInjectedEnvReuse({ env: { _VARLOCK_ENV_KEY: key! }, cwd: tempDir });
      expect(decision.reuse).toBe(true);
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });

  test('wins over an ambient __VARLOCK_ENV blob', () => {
    const { key } = writeFrozenFile();
    const decision = evaluateInjectedEnvReuse({
      env: {
        _VARLOCK_ENV_KEY: key!,
        __VARLOCK_ENV: graphJson({ config: { FOO: { value: 'from-ambient-blob', isSensitive: false } } }),
      },
      cwd: tempDir,
    });
    expect(decision.reuse).toBe(true);
    if (decision.reuse) {
      expect(decision.source).toBe('frozen-file');
      expect(decision.parsedEnv.config.FOO.value).toBe('foo-val');
    }
  });

  // the two sources are governed by separate flags
  test('is not disabled by _VARLOCK_USE_INJECTED_ENV=0', () => {
    const { key } = writeFrozenFile();
    const decision = evaluateInjectedEnvReuse({
      env: { _VARLOCK_ENV_KEY: key!, [USE_INJECTED_ENV_VAR]: '0' },
      cwd: tempDir,
    });
    expect(decision.reuse).toBe(true);
  });

  test('falls through to the normal blob path when disabled', () => {
    const { key } = writeFrozenFile();
    const decision = evaluateInjectedEnvReuse({
      env: { _VARLOCK_ENV_KEY: key!, [USE_FROZEN_ENV_VAR]: '0' },
      cwd: tempDir,
    });
    expect(decision).toMatchObject({ reuse: false, reason: expect.stringContaining('no injected env blob') });
  });

  test('strips @internal items', () => {
    const { key } = writeFrozenFile({
      contents: graphJson({
        config: {
          FOO: { value: 'foo-val', isSensitive: false },
          SECRET_ZERO: { value: 'nope', isSensitive: true, isInternal: true },
        },
      }),
    });
    const decision = evaluateInjectedEnvReuse({ env: { _VARLOCK_ENV_KEY: key! }, cwd: tempDir });
    expect(decision.reuse).toBe(true);
    if (decision.reuse) {
      expect(decision.strippedInternalKeys).toEqual(['SECRET_ZERO']);
      expect(decision.parsedEnv.config.SECRET_ZERO).toBeUndefined();
      expect(JSON.parse(decision.blobJson).config.SECRET_ZERO).toBeUndefined();
    }
  });

  test('throws rather than falling back when the file is not a serialized graph', () => {
    writeFrozenFile({ key: null, contents: JSON.stringify({ nope: true }) });
    expect(() => evaluateInjectedEnvReuse({ env: {}, cwd: tempDir }))
      .toThrow(/not a valid serialized env graph/);
  });

  test('throws when the file was created from a failed resolution', () => {
    writeFrozenFile({ key: null, contents: graphJson({ errors: { schemaErrors: [{ message: 'bad' }] } }) });
    expect(() => evaluateInjectedEnvReuse({ env: {}, cwd: tempDir }))
      .toThrow(/contains errors/);
  });
});

// A pin that leaves `@dynamic=boot` keys to the runtime is not a complete graph: it has to
// be applied on top of the schema, with those keys resolved live (see loadVarlockEnvGraph)
describe('a pin with boot keys', () => {
  const withBootKeys = () => graphJson({ frozen: { bootKeys: ['PORT'], currentEnv: 'production' } });

  test('a frozen file is handed back for schema resolution instead of reused', () => {
    const { key, filePath } = writeFrozenFile({ contents: withBootKeys() });
    const decision = evaluateInjectedEnvReuse({ env: { _VARLOCK_ENV_KEY: key! }, cwd: tempDir });
    expect(decision.reuse).toBe(false);
    if (!decision.reuse) {
      expect(decision.reason).toContain('leaves 1 key to boot (PORT)');
      expect(decision.pinned).toMatchObject({ source: 'frozen-file', filePath });
      expect(decision.pinned?.graph.config.SECRET.value).toBe('secret-val');
    }
  });

  test('so is a frozen payload trusted via _VARLOCK_USE_INJECTED_ENV=1', () => {
    const decision = evaluateInjectedEnvReuse({
      env: { [USE_INJECTED_ENV_VAR]: '1', __VARLOCK_ENV: withBootKeys() },
      cwd: tempDir,
    });
    expect(decision.reuse).toBe(false);
    if (!decision.reuse) expect(decision.pinned).toMatchObject({ source: 'env-blob' });
  });

  test('a pin without boot keys is still reused as-is', () => {
    const { key } = writeFrozenFile({ contents: graphJson({ frozen: { bootKeys: [] } }) });
    const decision = evaluateInjectedEnvReuse({ env: { _VARLOCK_ENV_KEY: key! }, cwd: tempDir });
    expect(decision.reuse).toBe(true);
  });

  describe('findPinnedGraphForResolution', () => {
    test('a merely-present frozen file is skipped when only explicit use is wanted', () => {
      const { key } = writeFrozenFile({ contents: withBootKeys() });
      expect(findPinnedGraphForResolution({ env: { _VARLOCK_ENV_KEY: key! }, cwd: tempDir, explicitFrozenOnly: true }))
        .toBeUndefined();
      expect(findPinnedGraphForResolution({ env: { _VARLOCK_ENV_KEY: key! }, cwd: tempDir }))
        .toMatchObject({ source: 'frozen-file' });
    });

    test('an explicitly named frozen file is returned, with or without boot keys', () => {
      const { key, filePath } = writeFrozenFile({ contents: graphJson({ frozen: { bootKeys: [] } }), fileName: 'pin.env' });
      const pinned = findPinnedGraphForResolution({
        env: { _VARLOCK_ENV_KEY: key!, [USE_FROZEN_ENV_VAR]: filePath },
        cwd: tempDir,
        explicitFrozenOnly: true,
      });
      expect(pinned).toMatchObject({ source: 'frozen-file', filePath });
    });

    test('a trusted __VARLOCK_ENV counts only when it is a freeze payload', () => {
      const frozenPayload = findPinnedGraphForResolution({
        env: { [USE_INJECTED_ENV_VAR]: '1', __VARLOCK_ENV: graphJson({ frozen: { bootKeys: [] } }) },
        cwd: tempDir,
      });
      expect(frozenPayload).toMatchObject({ source: 'env-blob' });
      // an ordinary sandbox blob is trusted for reuse, but it is not a pin to resolve on top of
      const plainBlob = findPinnedGraphForResolution({
        env: { [USE_INJECTED_ENV_VAR]: '1', __VARLOCK_ENV: graphJson() },
        cwd: tempDir,
      });
      expect(plainBlob).toBeUndefined();
    });

    test('nothing is a pin without a frozen file or explicit blob trust', () => {
      expect(findPinnedGraphForResolution({ env: { __VARLOCK_ENV: graphJson({ frozen: { bootKeys: ['PORT'] } }) }, cwd: tempDir }))
        .toBeUndefined();
    });
  });
});
