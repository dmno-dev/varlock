import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, vi } from 'vitest';
import { pluginTest } from 'varlock/test-helpers';

const pluginPath = fileURLToPath(new URL('..', import.meta.url));

test('loads the built plugin and generates config from a Varlock schema', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'varlock-effect-'));
  try {
    const graph = await pluginTest({
      resolveDir: directory,
      schema: `
# @plugin(${JSON.stringify(pluginPath)})
# @generateEffectConfig(path=./env.generated.ts, auto=false)
# ---
# @type=enum(development, production) @public
APP_ENV=development
# @type=array(string, format=json) @public
HOSTS='["localhost"]'
# @sensitive @required=false
TOKEN=
`,
      expectValues: { APP_ENV: 'development' },
    })();

    expect(graph).toBeDefined();
    expect((await graph!.runCodeGeneratorsIfNeeded()).generatedCount).toBe(0);
    expect((await graph!.runCodeGeneratorsIfNeeded({ ignoreAutoFalse: true })).generatedCount).toBe(1);

    const generated = await readFile(path.join(directory, 'env.generated.ts'), 'utf8');
    expect(generated).toContain('Config.literals(["development", "production"], "APP_ENV")');
    expect(generated).toContain('value as Array<string>');
    expect(generated).toContain('redactErrors(Config.option(Config.map(Config.string("TOKEN"), Redacted.make)), "TOKEN")');
    expect(generated).toContain('export const generated = config.pipe(Effect.orDie)');
  } finally {
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  }
});
