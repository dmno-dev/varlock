import {
  describe, test, expect, beforeEach, afterEach,
} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { evaluateInjectedEnvReuse, USE_INJECTED_ENV_VAR } from '../injected-env-reuse';
import { encryptEnvBlobSync, generateEncryptionKeyHex } from '../../runtime/crypto';

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-injected-env-reuse-'));
  // realpath so assertions aren't confused by symlinked tmp dirs (e.g. /tmp on macOS)
  tempDir = fs.realpathSync(tempDir);
});

afterEach(() => {
  if (tempDir && fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function makeBlob(overrides?: Record<string, any>) {
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

describe('evaluateInjectedEnvReuse', () => {
  describe('automatic mode', () => {
    test('reuses a matching blob', () => {
      const decision = evaluateInjectedEnvReuse({
        env: { __VARLOCK_ENV: makeBlob() },
        cwd: tempDir,
      });
      expect(decision.reuse).toBe(true);
      if (decision.reuse) {
        expect(decision.parsedEnv.config.FOO.value).toBe('foo-val');
      }
    });

    test('does not reuse when no blob is present', () => {
      const decision = evaluateInjectedEnvReuse({ env: {}, cwd: tempDir });
      expect(decision).toMatchObject({ reuse: false, reason: expect.stringContaining('no injected env blob') });
    });

    test('does not reuse when the blob was resolved in a different directory', () => {
      const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-other-'));
      try {
        const decision = evaluateInjectedEnvReuse({
          env: { __VARLOCK_ENV: makeBlob() },
          cwd: otherDir,
        });
        expect(decision).toMatchObject({ reuse: false, reason: expect.stringContaining('different directory') });
      } finally {
        fs.rmSync(otherDir, { recursive: true, force: true });
      }
    });

    test('directory comparison uses realpath (symlinks match)', () => {
      const linkPath = path.join(os.tmpdir(), `varlock-link-${path.basename(tempDir)}`);
      fs.symlinkSync(tempDir, linkPath);
      try {
        const decision = evaluateInjectedEnvReuse({
          env: { __VARLOCK_ENV: makeBlob() },
          cwd: linkPath,
        });
        expect(decision.reuse).toBe(true);
      } finally {
        fs.unlinkSync(linkPath);
      }
    });

    test('does not reuse a blob that contains errors', () => {
      const decision = evaluateInjectedEnvReuse({
        env: { __VARLOCK_ENV: makeBlob({ errors: { root: ['something failed'] } }) },
        cwd: tempDir,
      });
      expect(decision).toMatchObject({ reuse: false, reason: expect.stringContaining('errors') });
    });

    test('does not reuse a blob with no basePath', () => {
      const decision = evaluateInjectedEnvReuse({
        env: { __VARLOCK_ENV: makeBlob({ basePath: undefined }) },
        cwd: tempDir,
      });
      expect(decision).toMatchObject({ reuse: false, reason: expect.stringContaining('basePath') });
    });

    test('does not reuse an unparseable blob', () => {
      const decision = evaluateInjectedEnvReuse({
        env: { __VARLOCK_ENV: 'not-json' },
        cwd: tempDir,
      });
      expect(decision).toMatchObject({ reuse: false, reason: expect.stringContaining('not a valid') });
    });

    describe('package.json loadPath handling', () => {
      test('reuses when loadPath dir matches the blob basePath', () => {
        const envDir = path.join(tempDir, 'envs');
        fs.mkdirSync(envDir);
        fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({
          name: 'x', varlock: { loadPath: './envs' },
        }));
        const decision = evaluateInjectedEnvReuse({
          env: { __VARLOCK_ENV: makeBlob({ basePath: envDir }) },
          cwd: tempDir,
        });
        expect(decision.reuse).toBe(true);
      });

      test('does not reuse when loadPath points elsewhere than the blob basePath', () => {
        const envDir = path.join(tempDir, 'envs');
        fs.mkdirSync(envDir);
        fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({
          name: 'x', varlock: { loadPath: './envs' },
        }));
        const decision = evaluateInjectedEnvReuse({
          env: { __VARLOCK_ENV: makeBlob() }, // basePath = tempDir, not tempDir/envs
          cwd: tempDir,
        });
        expect(decision.reuse).toBe(false);
      });

      test('loadPath pointing at a file compares against its directory', () => {
        const envDir = path.join(tempDir, 'config');
        fs.mkdirSync(envDir);
        fs.writeFileSync(path.join(envDir, '.env.schema'), '');
        fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({
          name: 'x', varlock: { loadPath: './config/.env.schema' },
        }));
        const decision = evaluateInjectedEnvReuse({
          env: { __VARLOCK_ENV: makeBlob({ basePath: envDir }) },
          cwd: tempDir,
        });
        expect(decision.reuse).toBe(true);
      });

      test('does not reuse when loadPath points at a missing path (CLI should surface its error)', () => {
        fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({
          name: 'x', varlock: { loadPath: './does-not-exist' },
        }));
        const decision = evaluateInjectedEnvReuse({
          env: { __VARLOCK_ENV: makeBlob() },
          cwd: tempDir,
        });
        expect(decision.reuse).toBe(false);
      });
    });

    describe('override drift', () => {
      test('reuses when override values still match', () => {
        const decision = evaluateInjectedEnvReuse({
          env: { __VARLOCK_ENV: makeBlob({ overrideKeys: ['FOO'] }) },
          preInjectionEnv: { FOO: 'foo-val' },
          cwd: tempDir,
        });
        expect(decision.reuse).toBe(true);
      });

      test('does not reuse when an override value changed since the blob was created', () => {
        const decision = evaluateInjectedEnvReuse({
          env: { __VARLOCK_ENV: makeBlob({ overrideKeys: ['FOO'] }) },
          preInjectionEnv: { FOO: 'changed!' },
          cwd: tempDir,
        });
        expect(decision).toMatchObject({ reuse: false, reason: expect.stringContaining('FOO') });
      });

      test('drift on a key that was NOT an override at the parent still blocks reuse', () => {
        // FOO was resolved (not overridden) at the parent; setting it between the parent
        // run and the app boot is a newly introduced override that reuse would clobber
        const decision = evaluateInjectedEnvReuse({
          env: { __VARLOCK_ENV: makeBlob() }, // overrideKeys: []
          preInjectionEnv: { FOO: 'introduced-later' },
          cwd: tempDir,
        });
        expect(decision).toMatchObject({ reuse: false, reason: expect.stringContaining('FOO') });
      });

      test('an override key absent from the env is not drift (--inject blob mode)', () => {
        const decision = evaluateInjectedEnvReuse({
          env: { __VARLOCK_ENV: makeBlob({ overrideKeys: ['FOO'] }) },
          preInjectionEnv: {},
          cwd: tempDir,
        });
        expect(decision.reuse).toBe(true);
      });

      test('a coerced override\'s raw string form is an echo, not drift', () => {
        // parent ran with FLAG=YES (coerced to boolean true); under --inject blob the
        // raw "YES" survives in the child env and must not block reuse
        const blob = makeBlob({
          config: {
            FLAG: {
              value: true, overrideStr: 'YES', isSensitive: false,
            },
          },
          overrideKeys: ['FLAG'],
        });
        const rawForm = evaluateInjectedEnvReuse({
          env: { __VARLOCK_ENV: blob },
          preInjectionEnv: { FLAG: 'YES' },
          cwd: tempDir,
        });
        expect(rawForm.reuse).toBe(true);
        const coercedForm = evaluateInjectedEnvReuse({
          env: { __VARLOCK_ENV: blob },
          preInjectionEnv: { FLAG: 'true' },
          cwd: tempDir,
        });
        expect(coercedForm.reuse).toBe(true);
        // a value matching NEITHER form is a genuine change
        const changed = evaluateInjectedEnvReuse({
          env: { __VARLOCK_ENV: blob },
          preInjectionEnv: { FLAG: 'no' },
          cwd: tempDir,
        });
        expect(changed.reuse).toBe(false);
      });

      test('composite values compare via their envStr form', () => {
        const blob = makeBlob({
          config: {
            LIST: { value: ['a', 'b'], envStr: 'a,b', isSensitive: false },
          },
          overrideKeys: ['LIST'],
        });
        const matching = evaluateInjectedEnvReuse({
          env: { __VARLOCK_ENV: blob },
          preInjectionEnv: { LIST: 'a,b' },
          cwd: tempDir,
        });
        expect(matching.reuse).toBe(true);
        const drifted = evaluateInjectedEnvReuse({
          env: { __VARLOCK_ENV: blob },
          preInjectionEnv: { LIST: 'a,b,c' },
          cwd: tempDir,
        });
        expect(drifted.reuse).toBe(false);
      });
    });

    describe('encrypted blobs', () => {
      test('decrypts and reuses when the key is present', () => {
        const key = generateEncryptionKeyHex();
        const decision = evaluateInjectedEnvReuse({
          env: {
            __VARLOCK_ENV: encryptEnvBlobSync(makeBlob(), key),
            _VARLOCK_ENV_KEY: key,
          },
          cwd: tempDir,
        });
        expect(decision.reuse).toBe(true);
        if (decision.reuse) {
          expect(decision.parsedEnv.config.SECRET.value).toBe('secret-val');
          // blobJson is the decrypted plaintext form
          expect(decision.blobJson).toContain('secret-val');
        }
      });

      test('does not reuse an encrypted blob without a key', () => {
        const key = generateEncryptionKeyHex();
        const decision = evaluateInjectedEnvReuse({
          env: { __VARLOCK_ENV: encryptEnvBlobSync(makeBlob(), key) },
          cwd: tempDir,
        });
        expect(decision).toMatchObject({ reuse: false, reason: expect.stringContaining('encrypted') });
      });

      test('does not reuse when decryption fails (wrong key)', () => {
        const decision = evaluateInjectedEnvReuse({
          env: {
            __VARLOCK_ENV: encryptEnvBlobSync(makeBlob(), generateEncryptionKeyHex()),
            _VARLOCK_ENV_KEY: generateEncryptionKeyHex(),
          },
          cwd: tempDir,
        });
        expect(decision).toMatchObject({ reuse: false, reason: expect.stringContaining('decrypt') });
      });
    });
  });

  describe('_VARLOCK_FILTER interaction', () => {
    test('a set _VARLOCK_FILTER disables reuse (fresh resolution honors the filter)', () => {
      const decision = evaluateInjectedEnvReuse({
        env: { __VARLOCK_ENV: makeBlob(), _VARLOCK_FILTER: 'FOO' },
        cwd: tempDir,
      });
      expect(decision).toMatchObject({ reuse: false, reason: expect.stringContaining('_VARLOCK_FILTER') });
    });

    test('forced mode rejects _VARLOCK_FILTER instead of silently ignoring it', () => {
      expect(() => evaluateInjectedEnvReuse({
        env: { __VARLOCK_ENV: makeBlob(), _VARLOCK_FILTER: 'FOO', [USE_INJECTED_ENV_VAR]: '1' },
        cwd: tempDir,
      })).toThrow(/_VARLOCK_FILTER/);
    });
  });

  describe('@internal items in the blob', () => {
    const blobWithInternal = () => makeBlob({
      config: {
        FOO: { value: 'foo-val', isSensitive: false },
        SECRET_ZERO: { value: 'internal-val', isSensitive: false, isInternal: true },
      },
    });

    test('internal items are stripped on reuse and reported', () => {
      const decision = evaluateInjectedEnvReuse({
        env: { __VARLOCK_ENV: blobWithInternal() },
        cwd: tempDir,
      });
      expect(decision.reuse).toBe(true);
      if (decision.reuse) {
        expect(decision.strippedInternalKeys).toEqual(['SECRET_ZERO']);
        expect(decision.parsedEnv.config).not.toHaveProperty('SECRET_ZERO');
        expect(decision.parsedEnv.config.FOO.value).toBe('foo-val');
        // the re-serialized blob is clean too, so forwarding it cannot leak the value
        expect(decision.blobJson).not.toContain('internal-val');
      }
    });

    test('internal items are stripped in forced mode too', () => {
      const decision = evaluateInjectedEnvReuse({
        env: { __VARLOCK_ENV: blobWithInternal(), [USE_INJECTED_ENV_VAR]: '1' },
        cwd: tempDir,
      });
      expect(decision.reuse).toBe(true);
      if (decision.reuse) {
        expect(decision.strippedInternalKeys).toEqual(['SECRET_ZERO']);
        expect(decision.blobJson).not.toContain('SECRET_ZERO');
      }
    });

    test('blobs without internal items report an empty stripped list', () => {
      const decision = evaluateInjectedEnvReuse({
        env: { __VARLOCK_ENV: makeBlob() },
        cwd: tempDir,
      });
      expect(decision.reuse).toBe(true);
      if (decision.reuse) expect(decision.strippedInternalKeys).toEqual([]);
    });
  });

  describe(`explicit modes (${USE_INJECTED_ENV_VAR})`, () => {
    test('=0 disables reuse even for a matching blob', () => {
      const decision = evaluateInjectedEnvReuse({
        env: { __VARLOCK_ENV: makeBlob(), [USE_INJECTED_ENV_VAR]: '0' },
        cwd: tempDir,
      });
      expect(decision.reuse).toBe(false);
    });

    test('=1 reuses regardless of directory mismatch', () => {
      const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-other-'));
      try {
        const decision = evaluateInjectedEnvReuse({
          env: { __VARLOCK_ENV: makeBlob(), [USE_INJECTED_ENV_VAR]: '1' },
          cwd: otherDir,
        });
        expect(decision.reuse).toBe(true);
      } finally {
        fs.rmSync(otherDir, { recursive: true, force: true });
      }
    });

    test('=1 throws when no blob is present', () => {
      expect(() => evaluateInjectedEnvReuse({
        env: { [USE_INJECTED_ENV_VAR]: '1' },
        cwd: tempDir,
      })).toThrow(/no __VARLOCK_ENV blob/);
    });

    test('=1 throws when blob is encrypted and no key is set', () => {
      expect(() => evaluateInjectedEnvReuse({
        env: {
          __VARLOCK_ENV: encryptEnvBlobSync(makeBlob(), generateEncryptionKeyHex()),
          [USE_INJECTED_ENV_VAR]: '1',
        },
        cwd: tempDir,
      })).toThrow(/_VARLOCK_ENV_KEY/);
    });

    test('=1 throws on an unparseable blob', () => {
      expect(() => evaluateInjectedEnvReuse({
        env: { __VARLOCK_ENV: 'not-json', [USE_INJECTED_ENV_VAR]: '1' },
        cwd: tempDir,
      })).toThrow(/not a valid serialized env graph/);
    });

    test('accepts true/false (case-insensitive) as aliases for 1/0', () => {
      const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-other-'));
      try {
        const forced = evaluateInjectedEnvReuse({
          env: { __VARLOCK_ENV: makeBlob(), [USE_INJECTED_ENV_VAR]: 'TRUE' },
          cwd: otherDir, // would fail the dir check in auto mode
        });
        expect(forced.reuse).toBe(true);
      } finally {
        fs.rmSync(otherDir, { recursive: true, force: true });
      }
      const disabled = evaluateInjectedEnvReuse({
        env: { __VARLOCK_ENV: makeBlob(), [USE_INJECTED_ENV_VAR]: 'False' },
        cwd: tempDir, // would reuse in auto mode
      });
      expect(disabled.reuse).toBe(false);
    });

    test('unrecognized values fall back to auto mode, never force-trust', () => {
      // `f`, `no`, `off`, etc. must not be treated as either opt-in or opt-out
      const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-other-'));
      try {
        for (const rawValue of ['f', 'no', 'off', 'yes', 'anything']) {
          // dir mismatch: auto mode declines, so force-trust would be visible here
          const decision = evaluateInjectedEnvReuse({
            env: { __VARLOCK_ENV: makeBlob(), [USE_INJECTED_ENV_VAR]: rawValue },
            cwd: otherDir,
          });
          expect(decision.reuse).toBe(false);
        }
      } finally {
        fs.rmSync(otherDir, { recursive: true, force: true });
      }
      // and in a matching dir, auto mode still reuses (value didn't disable it either)
      const decision = evaluateInjectedEnvReuse({
        env: { __VARLOCK_ENV: makeBlob(), [USE_INJECTED_ENV_VAR]: 'yes' },
        cwd: tempDir,
      });
      expect(decision.reuse).toBe(true);
    });
  });
});
