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
import { evaluateInjectedEnvReuse, findExplicitFrozenEnv, USE_INJECTED_ENV_VAR } from '../injected-env-reuse';
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
  // silently disabling the frozen env
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

// `@dynamic=boot` items are frozen with a default, and a value set at boot overrides it after
// being checked against the type the freeze recorded - no schema, no CLI (see frozen-boot-keys)
describe('a frozen env with boot keys', () => {
  const withBootKeys = (overrides?: Record<string, any>) => graphJson({
    config: {
      FOO: { value: 'foo-val', isSensitive: false },
      PORT: { value: 3000, isSensitive: false },
      INSTANCE_ID: { value: undefined, isSensitive: false },
    },
    frozen: {
      boot: {
        PORT: { type: 'port', required: true },
        INSTANCE_ID: { type: 'string', required: false },
      },
    },
    ...overrides,
  });

  test('a boot-time value overrides the frozen default, coerced to the recorded type', () => {
    const { key } = writeFrozenFile({ contents: withBootKeys() });
    const decision = evaluateInjectedEnvReuse({ env: { ...ON, _VARLOCK_ENV_KEY: key!, PORT: '8080' }, cwd: tempDir });
    expect(decision.reuse).toBe(true);
    if (decision.reuse) {
      expect(decision.parsedEnv.config.PORT.value).toBe(8080);
      expect(JSON.parse(decision.blobJson).config.PORT.value).toBe(8080);
      expect(decision.parsedEnv.config.FOO.value).toBe('foo-val');
    }
  });

  test('without a boot-time value the frozen default stays', () => {
    const { key } = writeFrozenFile({ contents: withBootKeys() });
    const decision = evaluateInjectedEnvReuse({ env: { ...ON, _VARLOCK_ENV_KEY: key! }, cwd: tempDir });
    expect(decision.reuse && decision.parsedEnv.config.PORT.value).toBe(3000);
  });

  test('only boot keys read the boot environment - everything else stays frozen', () => {
    const { key } = writeFrozenFile({ contents: withBootKeys() });
    const decision = evaluateInjectedEnvReuse({ env: { ...ON, _VARLOCK_ENV_KEY: key!, FOO: 'ambient' }, cwd: tempDir });
    expect(decision.reuse && decision.parsedEnv.config.FOO.value).toBe('foo-val');
  });

  test('an invalid boot-time value fails closed, naming the key', () => {
    const { key } = writeFrozenFile({ contents: withBootKeys() });
    expect(() => evaluateInjectedEnvReuse({ env: { ...ON, _VARLOCK_ENV_KEY: key!, PORT: 'abc' }, cwd: tempDir }))
      .toThrow(/invalid @dynamic=boot value[\s\S]*PORT/);
  });

  test('a required boot key with no default must be set at boot', () => {
    const { key } = writeFrozenFile({
      contents: withBootKeys({
        frozen: { boot: { INSTANCE_ID: { type: 'string', required: true } } },
      }),
    });
    expect(() => evaluateInjectedEnvReuse({ env: { ...ON, _VARLOCK_ENV_KEY: key! }, cwd: tempDir }))
      .toThrow(/INSTANCE_ID is required, but it is not set at boot/);
    const decision = evaluateInjectedEnvReuse({ env: { ...ON, _VARLOCK_ENV_KEY: key!, INSTANCE_ID: 'i-1' }, cwd: tempDir });
    expect(decision.reuse && decision.parsedEnv.config.INSTANCE_ID.value).toBe('i-1');
  });

  test('a frozen payload trusted via _VARLOCK_USE_INJECTED_ENV=1 works the same way', () => {
    const decision = evaluateInjectedEnvReuse({
      env: { [USE_INJECTED_ENV_VAR]: '1', __VARLOCK_ENV: withBootKeys(), PORT: '9000' },
      cwd: tempDir,
    });
    expect(decision.reuse && decision.parsedEnv.config.PORT.value).toBe(9000);
  });

  // the automatic same-directory path checks ambient env for drift; a boot key differing
  // from its frozen default is the point, not drift
  test('an ambient frozen payload applies boot values instead of treating them as drift', () => {
    const decision = evaluateInjectedEnvReuse({ env: { __VARLOCK_ENV: withBootKeys(), PORT: '7000' }, cwd: tempDir });
    expect(decision.reuse && decision.parsedEnv.config.PORT.value).toBe(7000);
  });

  // e.g. an @internal item: freeze never records one, and the env must not introduce it
  test('a boot key with no frozen entry is never introduced from the env', () => {
    const decision = evaluateInjectedEnvReuse({
      env: {
        [USE_INJECTED_ENV_VAR]: '1',
        __VARLOCK_ENV: withBootKeys({ frozen: { boot: { SECRET_ZERO: { type: 'string', required: true } } } }),
        SECRET_ZERO: 'nope',
      },
      cwd: tempDir,
    });
    expect(decision.reuse && decision.parsedEnv.config.SECRET_ZERO).toBeUndefined();
  });

  test('boot values come from the pre-injection env, not one varlock injected', () => {
    const { key } = writeFrozenFile({ contents: withBootKeys() });
    const decision = evaluateInjectedEnvReuse({
      env: { ...ON, _VARLOCK_ENV_KEY: key!, PORT: '1111' },
      preInjectionEnv: { PORT: '2222' },
      cwd: tempDir,
    });
    expect(decision.reuse && decision.parsedEnv.config.PORT.value).toBe(2222);
  });

  describe('findExplicitFrozenEnv', () => {
    // load is what integrations resolve through, so a merely-present file is not used there
    test('a present frozen file is used only when named explicitly', () => {
      const { key } = writeFrozenFile();
      expect(findExplicitFrozenEnv({ env: { _VARLOCK_ENV_KEY: key! }, cwd: tempDir }))
        .toBeUndefined();
      expect(findExplicitFrozenEnv({ env: { ...ON, _VARLOCK_ENV_KEY: key! }, cwd: tempDir }))
        .toMatchObject({ source: 'frozen-file' });
    });

    test('a discovered file does not shadow a trusted frozen payload', () => {
      writeFrozenFile({ key: null, contents: graphJson({ frozen: {}, config: { FOO: { value: 'from-file' } } }) });
      const found = findExplicitFrozenEnv({
        env: { [USE_INJECTED_ENV_VAR]: '1', __VARLOCK_ENV: graphJson({ frozen: {} }) },
        cwd: tempDir,
      });
      expect(found).toMatchObject({ source: 'env-blob' });
      expect(found?.graph.config.FOO.value).toBe('foo-val');
    });

    test('an explicitly named frozen file is returned', () => {
      const { key, filePath } = writeFrozenFile({ contents: graphJson({ frozen: {} }), fileName: 'frozen.env' });
      const found = findExplicitFrozenEnv({
        env: { _VARLOCK_ENV_KEY: key!, [USE_FROZEN_ENV_VAR]: filePath },
        cwd: tempDir,
      });
      expect(found).toMatchObject({ source: 'frozen-file', filePath });
    });

    test('a trusted __VARLOCK_ENV counts only when it is a freeze payload', () => {
      const frozenPayload = findExplicitFrozenEnv({
        env: { [USE_INJECTED_ENV_VAR]: '1', __VARLOCK_ENV: graphJson({ frozen: {} }) },
        cwd: tempDir,
      });
      expect(frozenPayload).toMatchObject({ source: 'env-blob' });
      // an ordinary sandbox blob is trusted for reuse, but it is not a frozen env
      const plainBlob = findExplicitFrozenEnv({
        env: { [USE_INJECTED_ENV_VAR]: '1', __VARLOCK_ENV: graphJson() },
        cwd: tempDir,
      });
      expect(plainBlob).toBeUndefined();
    });

    test('nothing is a frozen env without a frozen file or explicit blob trust', () => {
      expect(findExplicitFrozenEnv({ env: { __VARLOCK_ENV: graphJson({ frozen: {} }) }, cwd: tempDir }))
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
