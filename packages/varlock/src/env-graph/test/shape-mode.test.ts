import {
  describe, test, expect, vi, afterEach,
} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import outdent from 'outdent';
import {
  EnvGraph, DotEnvFileDataSource, collectTypeGenItems, generateTsTypesSrc, resolveFieldTypes,
} from '../index';
import { loadGraph } from './type-generation/helpers';

// Each side-effect test has a positive control: the same schema in default mode must perform the
// side effect, so a passing shape-mode test can't come from a probe that never fires.

const tmpMarker = () => path.join(os.tmpdir(), `varlock-shape-${process.pid}-${Math.random().toString(36).slice(2)}`);

// A command that creates `marker` and prints `out`. Uses node rather than touch/echo so it also runs
// on Windows, and forward slashes so the path survives both shells.
const touchCmd = (marker: string, out: string) => {
  const m = marker.replace(/\\/g, '/');
  return `node -e "require('fs').writeFileSync('${m}', ''); process.stdout.write('${out}')"`;
};

async function load(
  envFile: string,
  mode: 'default' | 'shape',
  opts?: { resolve?: boolean, processEnv?: Record<string, string | undefined> },
) {
  const g = new EnvGraph({ mode });
  // guards the parity tests below: on a build without shape mode both graphs would be default mode
  expect(g.mode).toBe(mode);
  if (opts?.processEnv) g.processEnvOverride = opts.processEnv;
  const source = new DotEnvFileDataSource(path.join(__dirname, '.env.schema'), { overrideContents: envFile });
  await g.setRootDataSource(source);
  await g.finishLoad();
  if (opts?.resolve) await g.resolveEnvValues();
  return { g, source };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('EnvGraph shape mode', () => {
  test('exec() in an item value never runs, even when values are resolved', async () => {
    const marker = tmpMarker();
    const schema = outdent`
      # ---
      TOKEN=exec(\`${touchCmd(marker, 'secret')}\`)
    `;
    await load(schema, 'shape', { resolve: true });
    expect(fs.existsSync(marker)).toBe(false);

    const { g } = await load(schema, 'default', { resolve: true });
    expect(fs.existsSync(marker)).toBe(true); // control
    expect(g.configSchema.TOKEN.resolvedValue).toBe('secret');
    fs.rmSync(marker, { force: true });
  });

  test('a shell command in the @cache value never runs', async () => {
    const marker = tmpMarker();
    const schema = outdent`
      # @cache=exec(\`${touchCmd(marker, 'memory')}\`)
      # ---
      A=1
    `;
    await load(schema, 'shape');
    expect(fs.existsSync(marker)).toBe(false);

    await load(schema, 'default');
    expect(fs.existsSync(marker)).toBe(true); // control
    fs.rmSync(marker, { force: true });
  });

  test('@cache never creates a cache store', async () => {
    const schema = outdent`
      # @cache=memory
      # ---
      A=1
    `;
    const { g } = await load(schema, 'shape');
    expect(g._cacheStore).toBeUndefined();
    expect(g.shapeSkipped).toContainEqual({ kind: 'cacheStore', name: 'memory' });

    const { g: d } = await load(schema, 'default');
    expect(d._cacheStore).toBeDefined(); // control
  });

  test('root decorators are not executed (@setValuesBulk with exec)', async () => {
    const marker = tmpMarker();
    const schema = outdent`
      # @setValuesBulk(exec(\`${touchCmd(marker, '{}')}\`), format=json)
      # ---
      A=1
    `;
    const { g } = await load(schema, 'shape');
    expect(fs.existsSync(marker)).toBe(false);
    expect(g.shapeSkipped).toContainEqual({ kind: 'rootDecoratorExecute', name: 'setValuesBulk' });

    await load(schema, 'default');
    expect(fs.existsSync(marker)).toBe(true); // control
    fs.rmSync(marker, { force: true });
  });

  test('a pinned plugin that is not installed or cached is never downloaded', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network disabled in test'));
    const schema = outdent`
      # @plugin(@varlock/shape-mode-test-plugin@9.9.9)
      # ---
      A=1
    `;
    const { source, g } = await load(schema, 'shape');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(g.shapeSkipped).toContainEqual({ kind: 'pluginDownload', name: '@varlock/shape-mode-test-plugin@9.9.9' });
    expect(source.errors.map((e) => e.message).join('\n')).toMatch(/shape mode never downloads plugins/);

    await load(schema, 'default');
    expect(fetchSpy).toHaveBeenCalled(); // control: default mode asks the registry
  });

  test('pure resolvers still run: @currentEnv, forEnv, concat, ref, fallback', async () => {
    const { g } = await load(outdent`
      # @currentEnv=$APP_ENV
      # ---
      # @type=enum(development, production)
      APP_ENV=production
      HOST=example.com
      URL=concat("https://", $HOST)
      LABEL=fallback($MISSING_OPTIONAL, "default")
      # @optional
      MISSING_OPTIONAL=
      # @required=forEnv(production)
      PROD_ONLY=
    `, 'shape', { resolve: true });
    expect(g.configSchema.URL.resolvedValue).toBe('https://example.com');
    expect(g.configSchema.LABEL.resolvedValue).toBe('default');
    expect(g.configSchema.PROD_ONLY.isRequired).toBe(true);
    expect(g.shapeSkipped.filter((s) => s.kind === 'resolver')).toEqual([]);
  });

  test('a required item whose resolver was skipped is unknown, not a missing value', async () => {
    const schema = outdent`
      # @defaultRequired=true
      # ---
      SECRET=exec("echo hi")
      COPY=$SECRET
      PLAIN=
      # a resolver in the branch that is not taken is never skipped, so this is really empty
      UNTAKEN_BRANCH=if(eq(a, b), exec("echo hi"), "")
      # a skipped resolver in a decorator does not make the item's own value unknown
      # @sensitive=eq(exec("echo yes"), yes)
      EMPTY_WITH_SKIPPED_DECORATOR=
    `;
    const { g } = await load(schema, 'shape', { resolve: true });
    expect(g.configSchema.SECRET.errors).toEqual([]);
    expect(g.configSchema.COPY.errors).toEqual([]); // follows references
    expect(g.shapeSkipped).toContainEqual({ kind: 'resolver', name: 'exec', itemKey: 'SECRET' });
    // control: a required item that is really empty still fails
    for (const key of ['PLAIN', 'UNTAKEN_BRANCH', 'EMPTY_WITH_SKIPPED_DECORATOR']) {
      expect(g.configSchema[key].errors.map((e) => e.message)).toEqual(['Value is required but is currently empty']);
    }

    const { g: d } = await load(schema, 'default', { resolve: true });
    expect(d.configSchema.SECRET.resolvedValue).toBe('hi');
  });

  test('a value derived from a skipped resolver is not coerced or validated, a real error still is', async () => {
    const schema = outdent`
      # ---
      HOST=exec("echo example.com")
      # @type=url
      API=concat("https://", $HOST)
      # @type=url
      BAD_STATIC=not a url
    `;
    const { g } = await load(schema, 'shape', { resolve: true });
    expect(g.configSchema.API.errors).toEqual([]);
    expect(g.configSchema.API.resolvedValue).toBeUndefined();
    expect(g.configSchema.BAD_STATIC.errors.length).toBeGreaterThan(0);
    // a resolver that throws on the partial value (here domainFromUrl) is not a real failure either, nor is what depends on it
    const nested = await load(outdent`
      HOST=exec("echo example.com")
      DOMAIN=domainFromUrl(concat("https://", $HOST))
      LABEL=concat("domain: ", $DOMAIN)
    `, 'shape', { resolve: true });
    for (const key of ['HOST', 'DOMAIN', 'LABEL']) expect(nested.g.configSchema[key].errors).toEqual([]);

    const { g: d } = await load(schema, 'default', { resolve: true });
    expect(d.configSchema.API.resolvedValue).toBe('https://example.com');
    expect(d.configSchema.BAD_STATIC.errors.length).toBeGreaterThan(0);
  });

  test('resolving again forgets what an earlier run skipped', async () => {
    const { g } = await load(outdent`
      # @type=boolean
      FLAG=false
      VALUE=if($FLAG, "known", exec("echo hidden"))
    `, 'shape', { resolve: true });
    expect(g.configSchema.VALUE.isValueUnknownInShapeLoad).toBe(true);

    // flip the flag so the untouched, static branch is taken on the next resolve
    g.overrideValues.FLAG = 'true';
    await g.configSchema.FLAG.resolve(true);
    await g.configSchema.VALUE.resolve(true);
    expect(g.configSchema.VALUE.resolvedValue).toBe('known');
    expect(g.configSchema.VALUE.isValueUnknownInShapeLoad).toBe(false);
  });

  test('a @disable or @import condition built from a skipped resolver keeps the file', async () => {
    const files = {
      '.env.schema': outdent`
        # @import(./.env.imported, enabled=not(isEmpty(exec("echo yes"))))
        # @import(./.env.second)
        # ---
        ROOT=1
      `,
      '.env.imported': 'IMPORTED=1',
      '.env.second': outdent`
        # @disable=isEmpty(exec("echo yes"))
        # ---
        SECOND=1
      `,
    };
    const keys = async (mode: 'default' | 'shape') => {
      const g = await loadGraph({ files, mode });
      expect(g.mode).toBe(mode);
      return Object.keys(g.configSchema).sort();
    };
    expect(await keys('default')).toEqual(['IMPORTED', 'ROOT', 'SECOND']); // control
    expect(await keys('shape')).toEqual(['IMPORTED', 'ROOT', 'SECOND']);
  });

  test('an item read early by a root decorator and backed by a skipped resolver is unknown too', async () => {
    const schema = outdent`
      # @cache=$CACHE_MODE
      # @defaultRequired=true
      # ---
      CACHE_MODE=exec("echo memory")
    `;
    const { g, source } = await load(schema, 'shape', { resolve: true });
    expect(g.configSchema.CACHE_MODE.errors).toEqual([]);
    expect(source.errors.filter((e) => !e.isWarning)).toEqual([]);
    expect(g.shapeSkipped).toContainEqual(expect.objectContaining({ kind: 'resolver', name: 'exec' }));
  });

  test('plugin resolvers are skipped unless they set pure: true', async () => {
    const marker = tmpMarker();
    const schema = outdent`
      # @plugin(./plugins/test-plugin-shape/)
      # ---
      TOUCHED=shapeTouch("${marker}")
      SHOUTED=shapeShout("hi")
    `;
    const { g } = await load(schema, 'shape', { resolve: true });
    expect(fs.existsSync(marker)).toBe(false);
    expect(g.configSchema.TOUCHED.resolvedValue).toBeUndefined();
    expect(g.configSchema.SHOUTED.resolvedValue).toBe('HI');
    expect(g.shapeSkipped).toContainEqual({ kind: 'resolver', name: 'shapeTouch', itemKey: 'TOUCHED' });
    expect(g.shapeSkipped.map((s) => s.name)).not.toContain('shapeShout');

    const { g: d } = await load(schema, 'default', { resolve: true });
    expect(fs.existsSync(marker)).toBe(true); // control
    expect(d.configSchema.TOUCHED.resolvedValue).toBe('touched');
    fs.rmSync(marker, { force: true });
  });

  test('builtin vars still resolve from the environment: @currentEnv=$VARLOCK_ENV', async () => {
    const schema = outdent`
      # @currentEnv=$VARLOCK_ENV
      # ---
      # @required=forEnv(test)
      TEST_ONLY=
    `;
    const { g } = await load(schema, 'shape', { resolve: true, processEnv: { NODE_ENV: 'test' } });
    expect(g.configSchema.VARLOCK_ENV.resolvedValue).toBe('test');
    expect(g.configSchema.TEST_ONLY.isRequired).toBe(true);
    expect(g.shapeSkipped.filter((s) => s.kind === 'resolver')).toEqual([]);
  });

  // the fake git is a shell script
  test.skipIf(process.platform === 'win32')('VARLOCK_BRANCH does not spawn git', async () => {
    // a fake `git` first on PATH records that it was run
    const marker = tmpMarker();
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-shape-bin-'));
    fs.writeFileSync(path.join(binDir, 'git'), `#!/bin/sh\ntouch "${marker}"\necho fake-branch\n`, { mode: 0o755 });
    vi.stubEnv('PATH', `${binDir}${path.delimiter}${process.env.PATH}`);
    const schema = 'BRANCH=$VARLOCK_BRANCH';

    const { g } = await load(`# @defaultRequired=true\n# ---\n${schema}`, 'shape', { resolve: true, processEnv: {} });
    expect(fs.existsSync(marker)).toBe(false);
    expect(g.configSchema.VARLOCK_BRANCH.resolvedValue).toBeUndefined();
    // the skipped lookup is recorded, and the unknown branch is not reported as a missing required value
    expect(g.shapeSkipped).toContainEqual(expect.objectContaining({ kind: 'resolver', name: 'VARLOCK_BRANCH' }));
    expect(g.configSchema.BRANCH.errors).toEqual([]);

    const { g: d } = await load(schema, 'default', { resolve: true, processEnv: {} });
    expect(fs.existsSync(marker)).toBe(true); // control
    expect(d.configSchema.VARLOCK_BRANCH.resolvedValue).toBe('fake-branch');

    // a branch reported by the CI platform is only read from the environment, so it still works
    const ci = await load(schema, 'shape', { resolve: true, processEnv: { GITHUB_ACTIONS: 'true', GITHUB_REF_NAME: 'my-branch' } });
    expect(ci.g.configSchema.VARLOCK_BRANCH.resolvedValue).toBe('my-branch');
    fs.rmSync(marker, { force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
  });

  test('a process.env value does not override the schema', async () => {
    // the graph snapshots process.env when varlock is first imported, so import it again after setting the var
    vi.stubEnv('SHAPE_MODE_SHELL_VALUE', 'from-shell');
    vi.resetModules();
    const fresh = await import('../index');
    const resolveA = async (mode: 'default' | 'shape') => {
      const g = new fresh.EnvGraph({ mode });
      const source = new fresh.DotEnvFileDataSource(path.join(__dirname, '.env.schema'), {
        overrideContents: '# ---\nSHAPE_MODE_SHELL_VALUE=from-schema',
      });
      await g.setRootDataSource(source);
      await g.finishLoad();
      await g.resolveEnvValues();
      return g.configSchema.SHAPE_MODE_SHELL_VALUE.resolvedValue;
    };
    expect(await resolveA('shape')).toBe('from-schema');
    expect(await resolveA('default')).toBe('from-shell'); // control
    vi.resetModules();
  });

  test('validation warnings match default mode (root decorator deps are re-validated with final metadata)', async () => {
    // regression: skipping the whole root-decorator loop left @currentEnv's item with a stale
    // "very short sensitive value" warning from its early resolve, before @defaultSensitive applied
    // forEnv() resolves APP_ENV early, before its sensitivity is known; only the root-decorator loop
    // (resolving @currentEnv's deps) re-validates it afterwards
    const schema = outdent`
      # @currentEnv=$APP_ENV
      # @defaultRequired=true @defaultSensitive=false
      # ---
      APP_ENV=development
      # @required=forEnv(production)
      OP_TOKEN=
    `;
    const warnings = async (mode: 'default' | 'shape') => {
      const { g } = await load(schema, mode, { resolve: true });
      return g.sortedConfigKeys.flatMap((k) => g.configSchema[k].errors.map((e) => `${k}: ${e.message}`));
    };
    expect(await warnings('shape')).toEqual(await warnings('default'));
  });

  test('generated TypeScript is identical to default mode, across an import and an env-specific file', async () => {
    const files = {
      '.env.schema': outdent`
        # @currentEnv=$APP_ENV @defaultSensitive=false
        # @import(./.env.imported)
        # ---
        # @type=enum(development, production)
        APP_ENV=development
        TOKEN=exec("echo hi")
        # @required=forEnv(production)
        PROD_ONLY=
      `,
      '.env.imported': outdent`
        # @type=port
        IMPORTED_PORT=3000
      `,
      '.env.production': outdent`
        PROD_ONLY=from-production-file
        TOKEN=overridden
      `,
    };
    const generate = async (mode: 'default' | 'shape') => {
      const g = await loadGraph({ files, overrideValues: { APP_ENV: 'production' }, mode });
      expect(g.mode).toBe(mode);
      return generateTsTypesSrc(resolveFieldTypes(await collectTypeGenItems(g)));
    };
    const shapeSrc = await generate('shape');
    expect(shapeSrc).toContain('IMPORTED_PORT');
    expect(shapeSrc).not.toContain('from-production-file');
    expect(shapeSrc).toBe(await generate('default'));
  });

  test('generated types are the same as in default mode', async () => {
    const schema = outdent`
      # @currentEnv=$APP_ENV
      # @defaultRequired=infer
      # ---
      # @type=enum(development, staging, production)
      APP_ENV=development
      # @type=port
      PORT=3000
      # @type=url
      API=concat("https://", $HOST, "/api")
      HOST=example.com
      # @required=forEnv(production)
      SENTRY_DSN=
      TOKEN=exec("echo hi")
      # @sensitive
      SECRET=
    `;
    const info = async (mode: 'default' | 'shape') => {
      const { g } = await load(schema, mode);
      const out: Record<string, unknown> = {};
      for (const key of g.sortedConfigKeys) {
        const i = await g.configSchema[key].getTypeGenInfo();
        out[key] = {
          type: i.dataType?.coercedType ?? 'string', required: i.isRequired, requiredDynamic: i.isRequiredDynamic, sensitive: i.isSensitive,
        };
      }
      return out;
    };
    expect(await info('shape')).toEqual(await info('default'));
  });
});
