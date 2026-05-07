import {
  afterEach, beforeEach, describe, expect, test,
} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { scanCodeForEnvVars } from '../env-var-scanner';

describe('scanCodeForEnvVars', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-env-scan-'));
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('detects JS/TS env syntax including destructuring and ENV object', async () => {
    fs.writeFileSync(path.join(tempDir, 'index.ts'), [
      'const a = process.env.API_KEY;',
      'const b = process.env["DATABASE_URL"];',
      'const c = import.meta.env.VITE_PUBLIC_URL;',
      'const d = ENV.SECRET_TOKEN;',
      'const { PORT, NODE_ENV: envName, FEATURE_FLAG = "on" } = process.env;',
      'const { NEXT_PUBLIC_APP_URL } = import.meta.env;',
      'const { VARLOCK_ITEM } = ENV;',
    ].join('\n'));

    const result = await scanCodeForEnvVars({ cwd: tempDir });

    expect(result.keys).toEqual(expect.arrayContaining([
      'API_KEY',
      'DATABASE_URL',
      'VITE_PUBLIC_URL',
      'SECRET_TOKEN',
      'PORT',
      'NODE_ENV',
      'FEATURE_FLAG',
      'NEXT_PUBLIC_APP_URL',
      'VARLOCK_ITEM',
    ]));
  });

  test('detects multi-language env access patterns', async () => {
    fs.writeFileSync(path.join(tempDir, 'app.py'), 'import os\nos.getenv("PY_TOKEN")\nos.environ["PY_URL"]\n');
    fs.writeFileSync(path.join(tempDir, 'main.go'), 'package main\nimport "os"\nfunc main(){_ = os.Getenv("GO_KEY"); _ ,_ = os.LookupEnv("GO_OPT") }\n');
    fs.writeFileSync(path.join(tempDir, 'service.rb'), 'ENV["RB_SECRET"]\nENV.fetch("RB_URL")\n');
    fs.writeFileSync(path.join(tempDir, 'index.php'), '<?php getenv("PHP_DB"); $_ENV["PHP_TOKEN"]; $_SERVER["PHP_MODE"];');
    fs.writeFileSync(path.join(tempDir, 'main.rs'), 'fn main(){let _ = std::env::var("RS_KEY"); let _ = std::env::var_os("RS_OPT");}');
    fs.writeFileSync(path.join(tempDir, 'App.java'), 'class App { void go(){ System.getenv("JAVA_KEY"); } }');
    fs.writeFileSync(path.join(tempDir, 'Program.cs'), 'Environment.GetEnvironmentVariable("CS_KEY");');

    const result = await scanCodeForEnvVars({ cwd: tempDir });

    expect(result.keys).toEqual(expect.arrayContaining([
      'PY_TOKEN',
      'PY_URL',
      'GO_KEY',
      'GO_OPT',
      'RB_SECRET',
      'RB_URL',
      'PHP_DB',
      'PHP_TOKEN',
      'PHP_MODE',
      'RS_KEY',
      'RS_OPT',
      'JAVA_KEY',
      'CS_KEY',
    ]));
  });

  test('ignores commented-out and conversational string references', async () => {
    fs.writeFileSync(path.join(tempDir, 'comments.ts'), [
      '// process.env.COMMENTED_OUT',
      '/* import.meta.env.BLOCKED_OUT */',
      'const fromString = "process.env.INSIDE_STRING";',
      'const fromTemplate = `ENV.IN_TEMPLATE`;',
      'const real = process.env.REAL_ONE;',
      'const fromBracket = process.env["KEPT_KEY"];',
    ].join('\n'));

    const result = await scanCodeForEnvVars({ cwd: tempDir });

    expect(result.keys).toContain('REAL_ONE');
    expect(result.keys).not.toContain('COMMENTED_OUT');
    expect(result.keys).not.toContain('BLOCKED_OUT');
    expect(result.keys).toContain('KEPT_KEY');
    expect(result.keys).not.toContain('INSIDE_STRING');
    expect(result.keys).not.toContain('IN_TEMPLATE');
  });

  test('ignores go raw-string references while keeping real calls', async () => {
    fs.writeFileSync(path.join(tempDir, 'main.go'), [
      'package main',
      'import "os"',
      'func main() {',
      '  _ = `os.Getenv("IN_RAW_STRING")`',
      '  _ = os.Getenv("REAL_GO_KEY")',
      '}',
    ].join('\n'));

    const result = await scanCodeForEnvVars({ cwd: tempDir });

    expect(result.keys).toContain('REAL_GO_KEY');
    expect(result.keys).not.toContain('IN_RAW_STRING');
  });

  test('respects ignored directories', async () => {
    fs.mkdirSync(path.join(tempDir, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'node_modules', 'dep.js'), 'process.env.IGNORED_MOD');
    fs.writeFileSync(path.join(tempDir, 'app.ts'), 'process.env.VISIBLE_KEY');

    const result = await scanCodeForEnvVars({ cwd: tempDir });
    expect(result.keys).toContain('VISIBLE_KEY');
    expect(result.keys).not.toContain('IGNORED_MOD');
  });

  test('keeps default ignores while adding additional excluded directories', async () => {
    fs.mkdirSync(path.join(tempDir, 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'e2e'), { recursive: true });

    fs.writeFileSync(path.join(tempDir, 'node_modules', 'dep.js'), 'process.env.DEFAULT_IGNORED');
    fs.writeFileSync(path.join(tempDir, 'e2e', 'spec.ts'), 'process.env.CUSTOM_IGNORED');
    fs.writeFileSync(path.join(tempDir, 'app.ts'), 'process.env.VISIBLE_KEY');

    const result = await scanCodeForEnvVars({ cwd: tempDir }, ['e2e']);

    expect(result.keys).toContain('VISIBLE_KEY');
    expect(result.keys).not.toContain('DEFAULT_IGNORED');
    expect(result.keys).not.toContain('CUSTOM_IGNORED');
  });
});
