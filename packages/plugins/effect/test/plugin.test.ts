import {
  mkdir, mkdtemp, readFile, rm, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  afterEach, beforeEach, describe, expect, test, vi,
} from 'vitest';
import { pluginTest } from 'varlock/test-helpers';

const pluginPath = fileURLToPath(new URL('..', import.meta.url));

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'varlock-effect-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

/** Pretend `effect@<version>` is installed in the temp workspace so version detection can resolve it. */
async function installFakeEffect(version: string) {
  const dir = path.join(directory, 'node_modules', 'effect');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'effect', version, exports: { './package.json': './package.json' } }));
}

function loadGraph(decoratorArgs: string) {
  return pluginTest({
    resolveDir: directory,
    schema: `
# @plugin(${JSON.stringify(pluginPath)})
# @generateEffectConfig(path=./env.generated.ts, auto=false${decoratorArgs})
# ---
# @type=enum(development, production) @public
APP_ENV=development
# @type=array(string, format=json) @public
HOSTS='["localhost"]'
# @type=array(enum(), format=json) @public @required=false
EMPTY_ARRAY=
# @type=record(number, keyType=enum(true, false)) @public
BOOLEAN_KEYS='{"true":1,"false":2}'
# @sensitive @required=false
TOKEN=
`,
    expectValues: { APP_ENV: 'development' },
  })();
}

async function generate(decoratorArgs = '') {
  const graph = await loadGraph(decoratorArgs);
  expect(graph).toBeDefined();
  expect((await graph!.runCodeGeneratorsIfNeeded()).generatedCount).toBe(0);
  expect((await graph!.runCodeGeneratorsIfNeeded({ ignoreAutoFalse: true })).generatedCount).toBe(1);
  return readFile(path.join(directory, 'env.generated.ts'), 'utf8');
}

async function expectGenerateError(decoratorArgs: string, message: string) {
  const graph = await loadGraph(decoratorArgs);
  await expect(graph!.runCodeGeneratorsIfNeeded({ ignoreAutoFalse: true })).rejects.toThrow(message);
}

describe('loads the built plugin and generates config from a Varlock schema', () => {
  test('targets Effect 4 when a supported 4.x prerelease is installed', async () => {
    await installFakeEffect('4.0.0-rc.115');
    const generated = await generate();

    expect(generated).toContain('for Effect 4');
    expect(generated).toContain('Config.Literals(["development", "production"], "APP_ENV")');
    expect(generated).toContain('value as Array<string>');
    expect(generated).toContain('value as Array<never>');
    expect(generated).toContain('value as Partial<Record<"true" | "false", number>>');
    expect(generated).toContain('redactErrors(Config.option(Config.map(Config.String("TOKEN"), Redacted.make)), "TOKEN")');
    expect(generated).toContain('export const generated = config.pipe(Effect.orDie)');
  });

  test('targets Effect 4 when a stable 4.x release is installed', async () => {
    await installFakeEffect('4.1.0');
    expect(await generate()).toContain('Config.Literals(["development", "production"], "APP_ENV")');
  });

  test('targets Effect 3 when a 3.x release is installed', async () => {
    await installFakeEffect('3.22.2');
    const generated = await generate();

    expect(generated).toContain('for Effect 3');
    expect(generated).toContain('Config.literal("development", "production")("APP_ENV")');
    expect(generated).toContain('Config.mapAttempt(Config.string("HOSTS"), (value) => JSON.parse(value) as Array<string>)');
    expect(generated).toContain('JSON.parse(value) as Array<never>');
    expect(generated).toContain('JSON.parse(value) as Partial<Record<"true" | "false", number>>');
    expect(generated).toContain('"TOKEN": Config.option(Config.redacted(Config.string("TOKEN")))');
    expect(generated).toContain('export const generated = config.pipe(Effect.orDie)');
    expect(generated).not.toContain('effect/Schema');
  });

  test('uses effectVersion when effect is not installed', async () => {
    expect(await generate(', effectVersion=3')).toContain('Config.literal("development", "production")("APP_ENV")');
    expect(await generate(', effectVersion=4')).toContain('Config.Literals(["development", "production"], "APP_ENV")');
  });

  test('prefers an explicit effectVersion over the installed release', async () => {
    await installFakeEffect('3.22.2');
    expect(await generate(', effectVersion=4')).toContain('for Effect 4');
    await installFakeEffect('4.0.0-rc.112');
    expect(await generate(', effectVersion=3')).toContain('for Effect 3');
  });

  test('fails when effect is not installed and effectVersion is not set', async () => {
    await expectGenerateError('', 'could not find an installed `effect` package');
  });

  test('rejects an invalid effectVersion', async () => {
    await expectGenerateError(', effectVersion=5', '`effectVersion` must be 3 or 4');
  });

  test('rejects Effect 4 prereleases before the Config API rename', async () => {
    await installFakeEffect('4.0.0-rc.112');
    await expectGenerateError('', 'Upgrade to effect@4.0.0-rc.113 or later');
    await installFakeEffect('4.0.0-beta.107');
    await expectGenerateError('', 'Upgrade to effect@4.0.0-rc.113 or later');
  });

  test('rejects unsupported Effect majors', async () => {
    await installFakeEffect('2.4.0');
    await expectGenerateError('', 'effect@2.4.0 is not supported');
  });

  test('rejects unknown decorator options', async () => {
    await installFakeEffect('3.22.2');
    await expectGenerateError(', effectMajor=3', 'unknown option: effectMajor');
  });
});

test('rejects scalar enum collisions after Varlock resolves a quoted string member', async () => {
  await installFakeEffect('4.0.0-rc.115');
  const graph = await pluginTest({
    resolveDir: directory,
    schema: `
# @plugin(${JSON.stringify(pluginPath)})
# @generateEffectConfig(path=./env.generated.ts)
# ---
# @type=enum(1, "1") @public
AMBIGUOUS="1"
`,
    expectValues: { AMBIGUOUS: '1' },
  })();
  await expect(graph!.runCodeGeneratorsIfNeeded()).rejects.toThrow('cannot distinguish enum members');
});
