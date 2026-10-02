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
  PreResolvedEnvError,
  USE_FROZEN_ENV_VAR,
  getFrozenEnvFileInPlay,
  readFrozenEnvFile,
  resolveFrozenEnvFileMode,
} from '../frozen-env-file';
import { assertNoFrozenEnvFileInDev } from '../frozen-env-guard';
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

/** requires the frozen env file at the default path (a present file is also used without it) */
const ON = { [USE_FROZEN_ENV_VAR]: '1' };

/** write a frozen env file, encrypted unless `key` is null */
function writeFrozenFile(opts?: { key?: string | null, contents?: string, fileName?: string }) {
  const key = opts?.key === undefined ? generateEncryptionKeyHex() : opts.key;
  const json = opts?.contents ?? graphJson();
  const filePath = path.join(tempDir, opts?.fileName ?? FROZEN_ENV_FILE_NAME);
  fs.writeFileSync(filePath, `${key ? encryptEnvBlobSync(json, key) : json}\n`);
  return { filePath, key };
}

describe('resolveFrozenEnvFileMode', () => {
  test.each([undefined, '', '  '])('%s uses the default path if present', (rawValue) => {
    expect(resolveFrozenEnvFileMode({ [USE_FROZEN_ENV_VAR]: rawValue }, tempDir))
      .toEqual({ filePath: path.join(tempDir, FROZEN_ENV_FILE_NAME), required: false });
  });

  test.each(['1', 'true', 'TRUE', ' True '])('%s requires the default path', (rawValue) => {
    expect(resolveFrozenEnvFileMode({ [USE_FROZEN_ENV_VAR]: rawValue }, tempDir))
      .toEqual({ filePath: path.join(tempDir, FROZEN_ENV_FILE_NAME), required: true });
  });

  test.each(['0', 'false', 'False'])('%s disables frozen env files', (rawValue) => {
    expect(resolveFrozenEnvFileMode({ [USE_FROZEN_ENV_VAR]: rawValue }, tempDir)).toBeUndefined();
  });

  test('any other value is a required path, resolved against cwd', () => {
    expect(resolveFrozenEnvFileMode({ [USE_FROZEN_ENV_VAR]: 'dist/env.frozen' }, tempDir))
      .toEqual({ filePath: path.join(tempDir, 'dist/env.frozen'), required: true });
  });

  test('absolute paths are used as-is', () => {
    const abs = path.join(tempDir, 'somewhere', 'env.frozen');
    expect(resolveFrozenEnvFileMode({ [USE_FROZEN_ENV_VAR]: abs }, tempDir)).toEqual({ filePath: abs, required: true });
  });

  // unlike _VARLOCK_USE_INJECTED_ENV (which maps unknown values back to auto), an
  // unrecognized value here is a path - so a typo hard-errors as a missing file rather than
  // silently disabling the pin
  test('a typo`d disable value becomes a required path rather than disabling', () => {
    expect(resolveFrozenEnvFileMode({ [USE_FROZEN_ENV_VAR]: 'off' }, tempDir))
      .toEqual({ filePath: path.join(tempDir, 'off'), required: true });
    expect(() => readFrozenEnvFile({ env: { [USE_FROZEN_ENV_VAR]: 'off' }, cwd: tempDir }))
      .toThrow(/requires a frozen env file/);
  });
});

describe('readFrozenEnvFile', () => {
  test('returns undefined when no file is present', () => {
    expect(readFrozenEnvFile({ env: {}, cwd: tempDir })).toBeUndefined();
  });

  test('discovers a file at the default path', () => {
    writeFrozenFile({ key: null });
    expect(readFrozenEnvFile({ env: {}, cwd: tempDir })?.filePath).toBe(path.join(tempDir, FROZEN_ENV_FILE_NAME));
  });

  test('does not read anything when disabled', () => {
    writeFrozenFile({ key: null });
    expect(readFrozenEnvFile({ env: { [USE_FROZEN_ENV_VAR]: '0' }, cwd: tempDir })).toBeUndefined();
  });

  test('reads and decrypts a file at the default path', () => {
    const { key } = writeFrozenFile();
    const result = readFrozenEnvFile({ env: { ...ON, _VARLOCK_ENV_KEY: key! }, cwd: tempDir });
    expect(JSON.parse(result!.blobJson).config.FOO.value).toBe('foo-val');
  });

  test('reads a plaintext file', () => {
    writeFrozenFile({ key: null });
    const result = readFrozenEnvFile({ env: ON, cwd: tempDir });
    expect(JSON.parse(result!.blobJson).config.FOO.value).toBe('foo-val');
  });

  test('reads a file at an explicit path', () => {
    const { key, filePath } = writeFrozenFile({ fileName: 'custom.frozen' });
    const result = readFrozenEnvFile({
      env: { _VARLOCK_ENV_KEY: key!, [USE_FROZEN_ENV_VAR]: 'custom.frozen' },
      cwd: tempDir,
    });
    expect(result?.filePath).toBe(filePath);
  });

  test('throws when requested but missing', () => {
    expect(() => readFrozenEnvFile({ env: ON, cwd: tempDir }))
      .toThrow(FrozenEnvFileError);
  });

  describe('fail-closed on a present but unusable file', () => {
    test('throws when encrypted and no key is set', () => {
      writeFrozenFile();
      expect(() => readFrozenEnvFile({ env: ON, cwd: tempDir }))
        .toThrow(/_VARLOCK_ENV_KEY is not set/);
    });

    test('throws when the key is wrong', () => {
      writeFrozenFile();
      expect(() => readFrozenEnvFile({ env: { ...ON, _VARLOCK_ENV_KEY: generateEncryptionKeyHex() }, cwd: tempDir }))
        .toThrow(/failed to decrypt/);
    });

    test('throws when the file is empty', () => {
      fs.writeFileSync(path.join(tempDir, FROZEN_ENV_FILE_NAME), '\n');
      expect(() => readFrozenEnvFile({ env: ON, cwd: tempDir })).toThrow(/is empty/);
    });

    test('throws when combined with _VARLOCK_FILTER', () => {
      writeFrozenFile({ key: null });
      expect(() => readFrozenEnvFile({ env: { ...ON, _VARLOCK_FILTER: 'FOO' }, cwd: tempDir }))
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
      expect(() => readFrozenEnvFile({ env: ON, cwd: tempDir })).toThrow(/not a regular file/);
    });
  });
});

describe('getFrozenEnvFileInPlay', () => {
  test('undefined when disabled, or when nothing is present at the default path', () => {
    expect(getFrozenEnvFileInPlay({}, tempDir)).toBeUndefined();
    writeFrozenFile({ key: null });
    expect(getFrozenEnvFileInPlay({ [USE_FROZEN_ENV_VAR]: '0' }, tempDir)).toBeUndefined();
  });

  test('returns the path when present, or when required but missing', () => {
    expect(getFrozenEnvFileInPlay(ON, tempDir)).toBe(path.join(tempDir, FROZEN_ENV_FILE_NAME));
    const { filePath } = writeFrozenFile({ key: null });
    expect(getFrozenEnvFileInPlay({}, tempDir)).toBe(filePath);
  });
});

describe('evaluateInjectedEnvReuse with a frozen env file', () => {
  test('consumes the file with no env files present, and reports its source', () => {
    const { key } = writeFrozenFile();
    const decision = evaluateInjectedEnvReuse({ env: { ...ON, _VARLOCK_ENV_KEY: key! }, cwd: tempDir });
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
      const decision = evaluateInjectedEnvReuse({ env: { ...ON, _VARLOCK_ENV_KEY: key! }, cwd: tempDir });
      expect(decision.reuse).toBe(true);
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });

  test('wins over an ambient __VARLOCK_ENV blob', () => {
    const { key } = writeFrozenFile();
    const decision = evaluateInjectedEnvReuse({
      env: {
        ...ON,
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
      env: { ...ON, _VARLOCK_ENV_KEY: key!, [USE_INJECTED_ENV_VAR]: '0' },
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
    const decision = evaluateInjectedEnvReuse({ env: { ...ON, _VARLOCK_ENV_KEY: key! }, cwd: tempDir });
    expect(decision.reuse).toBe(true);
    if (decision.reuse) {
      expect(decision.strippedInternalKeys).toEqual(['SECRET_ZERO']);
      expect(decision.parsedEnv.config.SECRET_ZERO).toBeUndefined();
      expect(JSON.parse(decision.blobJson).config.SECRET_ZERO).toBeUndefined();
    }
  });

  test('throws rather than falling back when the file is not a serialized graph', () => {
    writeFrozenFile({ key: null, contents: JSON.stringify({ nope: true }) });
    expect(() => evaluateInjectedEnvReuse({ env: ON, cwd: tempDir }))
      .toThrow(/not a valid serialized env graph/);
  });

  test('throws when the file was created from a failed resolution', () => {
    writeFrozenFile({ key: null, contents: graphJson({ errors: { schemaErrors: [{ message: 'bad' }] } }) });
    expect(() => evaluateInjectedEnvReuse({ env: ON, cwd: tempDir }))
      .toThrow(/contains errors/);
  });
});

// A pin that leaves `@dynamic=boot` keys to the runtime is not a complete graph: it has to
// be applied on top of the schema, with those keys resolved live (see loadVarlockEnvGraph)
describe('a pin with boot keys', () => {
  const withBootKeys = () => graphJson({ frozen: { bootKeys: ['PORT'], currentEnv: 'production' } });

  test('a frozen file is handed back for schema resolution instead of reused', () => {
    const { key, filePath } = writeFrozenFile({ contents: withBootKeys() });
    const decision = evaluateInjectedEnvReuse({ env: { ...ON, _VARLOCK_ENV_KEY: key! }, cwd: tempDir });
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
    const decision = evaluateInjectedEnvReuse({ env: { ...ON, _VARLOCK_ENV_KEY: key! }, cwd: tempDir });
    expect(decision.reuse).toBe(true);
  });

  describe('findPinnedGraphForResolution', () => {
    // load is what integrations resolve through, so a merely-present file is not a pin there
    test('a present frozen file is a pin only when named explicitly', () => {
      const { key } = writeFrozenFile({ contents: withBootKeys() });
      expect(findPinnedGraphForResolution({ env: { _VARLOCK_ENV_KEY: key! }, cwd: tempDir }))
        .toBeUndefined();
      expect(findPinnedGraphForResolution({ env: { ...ON, _VARLOCK_ENV_KEY: key! }, cwd: tempDir }))
        .toMatchObject({ source: 'frozen-file' });
    });

    test('a discovered file does not shadow a trusted frozen payload', () => {
      writeFrozenFile({ key: null, contents: graphJson({ frozen: { bootKeys: [] }, config: { FOO: { value: 'from-file' } } }) });
      const pinned = findPinnedGraphForResolution({
        env: { [USE_INJECTED_ENV_VAR]: '1', __VARLOCK_ENV: graphJson({ frozen: { bootKeys: [] } }) },
        cwd: tempDir,
      });
      expect(pinned).toMatchObject({ source: 'env-blob' });
      expect(pinned?.graph.config.FOO.value).toBe('foo-val');
    });

    test('an explicitly named frozen file is returned, with or without boot keys', () => {
      const { key, filePath } = writeFrozenFile({ contents: graphJson({ frozen: { bootKeys: [] } }), fileName: 'pin.env' });
      const pinned = findPinnedGraphForResolution({
        env: { _VARLOCK_ENV_KEY: key!, [USE_FROZEN_ENV_VAR]: filePath },
        cwd: tempDir,
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

describe('assertNoFrozenEnvFileInDev', () => {
  test('passes when no file is present', () => {
    expect(() => assertNoFrozenEnvFileInDev({ cwd: tempDir, devCommand: 'vite dev', env: {} })).not.toThrow();
  });

  test('throws when a file is present, naming both remedies', () => {
    writeFrozenFile();
    expect(() => assertNoFrozenEnvFileInDev({ cwd: tempDir, devCommand: 'vite dev', env: {} }))
      .toThrow(/\.varlock-frozen-env is present, but `vite dev`[\s\S]*rm \.varlock-frozen-env[\s\S]*_VARLOCK_USE_FROZEN_ENV=0/);
  });

  test('checks a path named by _VARLOCK_USE_FROZEN_ENV', () => {
    writeFrozenFile({ fileName: 'custom.frozen' });
    expect(() => assertNoFrozenEnvFileInDev({ cwd: tempDir, devCommand: 'next dev', env: { [USE_FROZEN_ENV_VAR]: 'custom.frozen' } }))
      .toThrow(/custom\.frozen is present/);
  });

  test('_VARLOCK_USE_FROZEN_ENV=0 opts out', () => {
    writeFrozenFile();
    expect(() => assertNoFrozenEnvFileInDev({ cwd: tempDir, devCommand: 'vite dev', env: { [USE_FROZEN_ENV_VAR]: '0' } }))
      .not.toThrow();
  });
});

// every failure carries a remedy for that specific case, shown the same way by auto-load,
// `run`, and `load` - a generic "re-create it" is wrong advice for a file that was never shipped
describe('failure suggestions', () => {
  function suggestionFor(fn: () => unknown) {
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(PreResolvedEnvError);
      return (err as PreResolvedEnvError).suggestion;
    }
    throw new Error('expected a throw');
  }

  test('a required frozen file that is missing points at the deploy, not the key', () => {
    const suggestion = suggestionFor(() => readFrozenEnvFile({ env: ON, cwd: tempDir }));
    expect(suggestion).toContain('did not make it into this deploy');
    expect(suggestion).not.toContain('_VARLOCK_ENV_KEY');
  });

  test('a frozen file with the wrong key points at the key', () => {
    writeFrozenFile();
    const suggestion = suggestionFor(() => readFrozenEnvFile({
      env: { ...ON, _VARLOCK_ENV_KEY: generateEncryptionKeyHex() },
      cwd: tempDir,
    }));
    expect(suggestion).toContain('must be the key it was frozen with');
  });

  test('a trusted __VARLOCK_ENV that is missing names both producers', () => {
    const suggestion = suggestionFor(() => evaluateInjectedEnvReuse({ env: { [USE_INJECTED_ENV_VAR]: '1' }, cwd: tempDir }));
    expect(suggestion).toContain('varlock freeze --out -');
    expect(suggestion).toContain('varlock load --format json-full --compact');
  });

  test('a trusted __VARLOCK_ENV that is mangled says so', () => {
    const suggestion = suggestionFor(() => evaluateInjectedEnvReuse({
      env: { [USE_INJECTED_ENV_VAR]: '1', __VARLOCK_ENV: '{"trunc' },
      cwd: tempDir,
    }));
    expect(suggestion).toContain('truncated');
  });
});
