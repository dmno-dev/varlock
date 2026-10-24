// End-to-end tests: each one runs the real TypeScript 7.1 `tsc --runExternalCode`, which starts the built mapper
// (dist/server.mjs) the same way an app would. Needs `bunx turbo run build --filter=@varlock/ts-content-mapper`
// first (turbo's test:ci task does that).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  afterAll, beforeAll, describe, expect, it,
} from 'vitest';

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLE_DIR = path.join(PKG_DIR, 'example');
const TSC = path.join(EXAMPLE_DIR, 'node_modules/.bin/tsc');
const NETWORK_GUARD = path.join(PKG_DIR, 'test/fixtures/network-guard.mjs');

const TSCONFIG = {
  compilerOptions: {
    target: 'es2023', lib: ['ES2023'], module: 'nodenext', moduleResolution: 'nodenext', strict: true, noEmit: true, skipLibCheck: true,
  },
  contentMappers: [{ package: '@varlock/ts-content-mapper', extensions: ['.schema'], options: { exposeEnv: 'global' } }],
  include: ['src', '.env.schema'],
};

const tmpDirs: Array<string> = [];
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

beforeAll(() => {
  for (const f of [path.join(PKG_DIR, 'dist/server.mjs'), path.join(PKG_DIR, '../varlock/dist/index.mjs'), TSC]) {
    if (!fs.existsSync(f)) throw new Error(`${f} is missing: run \`bun install\` and \`bunx turbo run build --filter=@varlock/ts-content-mapper\``);
  }
});

/** a throwaway project outside the repo that resolves varlock, the mapper and TS 7.1 through the example's node_modules */
function makeProject(files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'varlock-ts-mapper-'));
  tmpDirs.push(dir);
  fs.symlinkSync(path.join(EXAMPLE_DIR, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify(TSCONFIG, null, 2));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

function runTsc(projectDir: string, env: Record<string, string> = {}) {
  const r = spawnSync(TSC, ['-p', projectDir, '--runExternalCode', '--pretty', 'false'], {
    cwd: projectDir, encoding: 'utf8', timeout: 60_000, env: { ...process.env, ...env },
  });
  return { status: r.status, output: `${r.stdout}${r.stderr}`.trim() };
}

const exampleSchema = () => fs.readFileSync(path.join(EXAMPLE_DIR, '.env.schema'), 'utf8');
const typeAssertions = () => fs.readFileSync(path.join(EXAMPLE_DIR, 'src/type-assertions.ts'), 'utf8');

describe('the example app', () => {
  it('type-checks, with ENV typed from .env.schema', () => {
    const r = runTsc(EXAMPLE_DIR);
    expect(r.output).toBe('');
    expect(r.status).toBe(0);
  });

  it('needs --runExternalCode (without it ENV has none of the schema keys)', () => {
    const r = spawnSync(TSC, ['-p', EXAMPLE_DIR, '--pretty', 'false'], { encoding: 'utf8' });
    expect(r.stdout).toContain('TS18068');
    expect(r.stdout).toContain("Property 'PORT' does not exist");
  });

  it('has type assertions that fail when the schema types change', () => {
    // control for the test above: the same assertion file against a schema with different types must not compile
    const schema = exampleSchema()
      .replace('# @type=port @required\nPORT', '# @type=string @required\nPORT')
      .replace('# @type=enum(debug, info, warn, error) @required', '# @type=enum(debug, info) @required')
      .replace('# @type=url\nSENTRY_DSN', '# @type=url @required\nSENTRY_DSN');
    const dir = makeProject({ '.env.schema': schema, 'src/type-assertions.ts': typeAssertions() });
    const r = runTsc(dir);
    expect(r.status).not.toBe(0);
    const failing = [...r.output.matchAll(/src\/type-assertions\.ts\((\d+),\d+\): error TS2344/g)].map((m) => Number(m[1]));
    const lineOf = (needle: string) => typeAssertions().split('\n').findIndex((l) => l.includes(needle)) + 1;
    expect(failing.sort()).toEqual([lineOf('ENV.PORT'), lineOf('ENV.LOG_LEVEL'), lineOf('ENV.SENTRY_DSN')].sort());
  });
});

describe('type errors', () => {
  it('reports a wrong-typed use of ENV in app code', () => {
    const dir = makeProject({
      '.env.schema': exampleSchema(),
      'src/index.ts': [
        "import { ENV } from 'varlock/env';",
        'export const port: string = ENV.PORT;',
        "export const level: 'trace' = ENV.LOG_LEVEL;",
        'export const missing = ENV.NOT_IN_SCHEMA;',
        '',
      ].join('\n'),
    });
    const r = runTsc(dir);
    expect(r.status).toBe(2);
    expect(r.output).toContain("src/index.ts(2,14): error TS2322: Type 'number' is not assignable to type 'string'.");
    expect(r.output).toMatch(/src\/index\.ts\(3,14\): error TS2322: Type '"debug" \| "error" \| "info" \| "warn"' is not assignable to type '"trace"'/);
    expect(r.output).toContain("src/index.ts(4,28): error TS2339: Property 'NOT_IN_SCHEMA' does not exist");
  });

  it('reports schema errors as TS diagnostics located in .env.schema, next to app errors', () => {
    const dir = makeProject({
      '.env.schema': [
        '# @defaultSensitive=false',
        '# ---',
        '# @type=port',
        'PORT=not-a-port',
        '# @type=porrt',
        'OTHER_PORT=8080',
        '',
      ].join('\n'),
      'src/index.ts': "import { ENV } from 'varlock/env';\nexport const p: string = ENV.PORT;\n",
    });
    const r = runTsc(dir);
    expect(r.status).toBe(2);
    // invalid static value: varlock's own coerce/validate, at the value
    expect(r.output).toMatch(/^\.env\.schema\(4,6\): error TS2345: .*varlock: PORT: /m);
    // unknown data type: a TS "did you mean" at the type name
    expect(r.output).toMatch(/^\.env\.schema\(5,9\): error TS2551: Property 'porrt' does not exist on type 'VarlockDataTypes'\. Did you mean 'port'\?/m);
    // the schema errors do not hide app errors
    expect(r.output).toContain("src/index.ts(2,14): error TS2322: Type 'number' is not assignable to type 'string'.");
  });
});

describe('shape mode', () => {
  it('never runs exec() from the schema, and still types the other items', () => {
    const dir = makeProject({});
    const itemMarker = path.join(dir, 'MARKER_ITEM');
    const bulkMarker = path.join(dir, 'MARKER_BULK');
    const schema = [
      '# @defaultSensitive=false',
      `# @setValuesBulk(exec("touch '${bulkMarker}' && echo {}"), format=json)`,
      '# ---',
      `TOKEN=exec("touch '${itemMarker}'")`,
      '# @type=port',
      'PORT=3000',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, '.env.schema'), schema);
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src/index.ts'), "import { ENV } from 'varlock/env';\nexport const p: number = ENV.PORT;\nexport const t: string | undefined = ENV.TOKEN;\n");

    const r = runTsc(dir);
    expect(r.output).toBe('');
    expect(r.status).toBe(0);
    expect(fs.existsSync(itemMarker)).toBe(false);
    expect(fs.existsSync(bulkMarker)).toBe(false);

    // control: the same schema loaded by varlock in default mode does run both commands
    const load = `
      const { internal } = await import('varlock');
      const g = new internal.EnvGraph();
      g.basePath = ${JSON.stringify(dir)};
      await g.setRootDataSource(new internal.DotEnvFileDataSource(${JSON.stringify(path.join(dir, '.env.schema'))}));
      await g.finishLoad();
      await g.resolveEnvValues();
    `;
    const c = spawnSync(process.execPath, ['--input-type=module', '-e', load], { cwd: PKG_DIR, encoding: 'utf8' });
    expect(c.stderr).toBe('');
    expect(fs.existsSync(itemMarker)).toBe(true);
    expect(fs.existsSync(bulkMarker)).toBe(true);
  });

  it('makes no network request, even for a pinned plugin that is not installed', () => {
    const dir = makeProject({
      '.env.schema': '# @plugin(@varlock/doppler-plugin@2.0.2)\n# ---\n# @type=port\nPORT=3000\n',
      'src/index.ts': "import { ENV } from 'varlock/env';\nexport const env = ENV;\n",
    });
    const home = path.join(dir, 'home');
    fs.mkdirSync(home);
    const log = path.join(dir, 'network.log');
    const env = {
      NODE_OPTIONS: `--import=${NETWORK_GUARD}`, NETWORK_GUARD_LOG: log, HOME: home, XDG_CONFIG_HOME: home,
    };
    const r = runTsc(dir, env);
    const events = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    // the guard was loaded into the mapper process itself
    expect(events.some((e) => e.kind === 'loaded' && e.argv.some((a: string) => a.endsWith('dist/server.mjs')))).toBe(true);
    expect(events.filter((e) => e.kind === 'network')).toEqual([]);
    // the refusal shows up as a TS error on the @plugin line, and nothing lands in varlock's plugin cache
    expect(r.output).toMatch(/^\.env\.schema\(1,\d+\): error TS2345: .*shape mode never downloads plugins/m);
    expect(fs.readdirSync(home)).toEqual([]);

    // control: the guard does see a request when one is made
    const controlLog = path.join(dir, 'control.log');
    spawnSync(process.execPath, ['-e', "fetch('http://127.0.0.1:9/').catch(() => {})"], {
      encoding: 'utf8', env: { ...process.env, ...env, NETWORK_GUARD_LOG: controlLog },
    });
    expect(fs.readFileSync(controlLog, 'utf8')).toContain('"kind":"network"');
  });

  it('keeps values of sensitive items out of the virtual TypeScript', () => {
    const dir = makeProject({
      '.env.schema': [
        '# @defaultSensitive=false',
        '# ---',
        '# @sensitive @example=sk_example_secret_value',
        'STATIC_SECRET=sk_live_static_secret_value',
        '',
      ].join('\n'),
      'src/index.ts': "import { ENV } from 'varlock/env';\nexport const s: string | undefined = ENV.STATIC_SECRET;\n",
    });
    const dump = path.join(dir, 'dump');
    const r = runTsc(dir, { VARLOCK_MAPPER_DUMP: dump });
    expect(r.output).toBe('');
    const virtual = fs.readdirSync(dump).map((f) => fs.readFileSync(path.join(dump, f), 'utf8')).join('\n');
    expect(virtual).toContain('STATIC_SECRET');
    expect(virtual).not.toContain('sk_live_static_secret_value');
    expect(virtual).not.toContain('sk_example_secret_value');
  });
});
