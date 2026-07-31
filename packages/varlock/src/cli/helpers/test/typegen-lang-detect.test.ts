import {
  describe, expect, test, afterEach,
} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { detectTypegenDecorator } from '../typegen-lang-detect';

const tmpDirs: Array<string> = [];

async function makeProjectDir(files: Array<string>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'varlock-typegen-detect-'));
  tmpDirs.push(dir);
  for (const file of files) {
    await fs.writeFile(path.join(dir, file), '', 'utf-8');
  }
  return dir;
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('detectTypegenDecorator', () => {
  test.each([
    [['package.json'], 'generateTsTypes'],
    [['pyproject.toml'], 'generatePythonEnv'],
    [['requirements.txt'], 'generatePythonEnv'],
    [['go.mod'], 'generateGoEnv'],
    [['Cargo.toml'], 'generateRustEnv'],
    [['composer.json'], 'generatePhpEnv'],
    [['pom.xml'], 'generateJavaEnv'],
    [['build.gradle'], 'generateJavaEnv'],
    [['build.gradle.kts'], 'generateJavaEnv'],
  ] as const)('detects %s -> @%s', async (files, decorator) => {
    const dir = await makeProjectDir([...files]);
    expect((await detectTypegenDecorator(dir)).decorator).toBe(decorator);
  });

  test('detects a .csproj as C#', async () => {
    const dir = await makeProjectDir(['MyApp.csproj']);
    const choice = await detectTypegenDecorator(dir);
    expect(choice.decorator).toBe('generateCsharpEnv');
    expect(choice.args).toContain('Env.cs');
  });

  test('detects a .sln as C#', async () => {
    const dir = await makeProjectDir(['MyApp.sln']);
    expect((await detectTypegenDecorator(dir)).decorator).toBe('generateCsharpEnv');
  });

  test('package.json (JS/TS) wins when multiple languages are present', async () => {
    const dir = await makeProjectDir(['package.json', 'pyproject.toml', 'go.mod']);
    expect((await detectTypegenDecorator(dir)).decorator).toBe('generateTsTypes');
  });

  test('falls back to TypeScript when nothing is detected', async () => {
    const dir = await makeProjectDir([]);
    const choice = await detectTypegenDecorator(dir);
    expect(choice.decorator).toBe('generateTsTypes');
    expect(choice.args).toContain('env.d.ts');
  });
});
