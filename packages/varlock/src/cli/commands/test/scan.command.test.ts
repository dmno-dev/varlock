import {
  describe, test, expect, beforeEach, afterEach,
} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scanFileForValues, walkDirectory } from '../scan.command';

describe('scanFileForValues', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-scan-test-'));
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('returns no findings for a clean file', async () => {
    const filePath = path.join(tempDir, 'clean.ts');
    fs.writeFileSync(filePath, 'const x = "hello world";\nconsole.log(x);\n');
    const sensitiveValues = new Map([['DB_PASSWORD', 'super-secret-password']]);
    const findings = await scanFileForValues(filePath, sensitiveValues);
    expect(findings).toHaveLength(0);
  });

  test('detects a sensitive value in a file', async () => {
    const filePath = path.join(tempDir, 'config.ts');
    const secretVal = 'my-real-secret-token-abc123';
    fs.writeFileSync(filePath, `const token = "${secretVal}";\n`);
    const sensitiveValues = new Map([['API_TOKEN', secretVal]]);
    const findings = await scanFileForValues(filePath, sensitiveValues);
    expect(findings).toHaveLength(1);
    expect(findings[0].sensitiveKeyName).toBe('API_TOKEN');
    expect(findings[0].sensitiveValue).toBe(secretVal);
    expect(findings[0].lineNumber).toBe(1);
    // secret starts at column 16 (after `const token = "`)
    expect(findings[0].columnNumber).toBe(16);
  });

  test('detects multiple sensitive values across multiple lines', async () => {
    const filePath = path.join(tempDir, 'secrets.ts');
    const dbPassword = 'my-db-password-xyz';
    const apiKey = 'my-api-key-abc';
    fs.writeFileSync(filePath, [
      `const dbUrl = "postgres://user:${dbPassword}@host";`,
      `const apiKey = "${apiKey}";`,
      'const normalVar = "hello";',
    ].join('\n'));
    const sensitiveValues = new Map([
      ['DB_PASSWORD', dbPassword],
      ['API_KEY', apiKey],
    ]);
    const findings = await scanFileForValues(filePath, sensitiveValues);
    expect(findings).toHaveLength(2);
    expect(findings[0].sensitiveKeyName).toBe('DB_PASSWORD');
    expect(findings[0].lineNumber).toBe(1);
    // password starts at column 32 (after `const dbUrl = "postgres://user:`)
    expect(findings[0].columnNumber).toBe(32);
    expect(findings[1].sensitiveKeyName).toBe('API_KEY');
    expect(findings[1].lineNumber).toBe(2);
    // apiKey starts at column 17 (after `const apiKey = "`)
    expect(findings[1].columnNumber).toBe(17);
  });

  test('returns no findings for a non-existent file', async () => {
    const sensitiveValues = new Map([['MY_SECRET', 'some-secret-value']]);
    const findings = await scanFileForValues(path.join(tempDir, 'does-not-exist.ts'), sensitiveValues);
    expect(findings).toHaveLength(0);
  });

  test('skips binary files (files with null bytes)', async () => {
    const filePath = path.join(tempDir, 'binary.bin');
    const secretVal = 'secret-value-123';
    // Write file content with null byte: starts with secret value but has null byte embedded
    const buf = Buffer.concat([
      Buffer.from(secretVal),
      Buffer.from([0x00]), // null byte marks it as binary
      Buffer.from(' extra data'),
    ]);
    fs.writeFileSync(filePath, buf);
    const sensitiveValues = new Map([['MY_SECRET', secretVal]]);
    const findings = await scanFileForValues(filePath, sensitiveValues);
    // The file is skipped because it contains a null byte
    expect(findings).toHaveLength(0);

    // Confirm the same content without the null byte WOULD be detected
    const textFilePath = path.join(tempDir, 'text-with-secret.ts');
    fs.writeFileSync(textFilePath, `const val = "${secretVal}";`);
    const textFindings = await scanFileForValues(textFilePath, sensitiveValues);
    expect(textFindings).toHaveLength(1);
    expect(textFindings[0].sensitiveKeyName).toBe('MY_SECRET');
  });

  test('only reports one finding per line even if multiple sensitive values match', async () => {
    const filePath = path.join(tempDir, 'multi.env');
    const secret1 = 'first-secret-abc';
    const secret2 = 'second-secret-xyz';
    // One line containing both sensitive values
    fs.writeFileSync(filePath, `COMBINED="${secret1}${secret2}"\n`);
    const sensitiveValues = new Map([
      ['SECRET_1', secret1],
      ['SECRET_2', secret2],
    ]);
    const findings = await scanFileForValues(filePath, sensitiveValues);
    expect(findings).toHaveLength(1);
    expect(findings[0].lineNumber).toBe(1);
  });

  test('returns no findings when sensitiveValues map is empty', async () => {
    const filePath = path.join(tempDir, 'any.ts');
    fs.writeFileSync(filePath, 'const x = "some value";\n');
    const findings = await scanFileForValues(filePath, new Map());
    expect(findings).toHaveLength(0);
  });
});

describe('walkDirectory', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-walk-test-'));
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('finds files in directory', async () => {
    fs.writeFileSync(path.join(tempDir, 'file1.ts'), 'content');
    fs.writeFileSync(path.join(tempDir, 'file2.ts'), 'content');
    const files = await walkDirectory(tempDir);
    expect(files).toHaveLength(2);
  });

  test('skips node_modules directory', async () => {
    fs.writeFileSync(path.join(tempDir, 'file.ts'), 'content');
    fs.mkdirSync(path.join(tempDir, 'node_modules'));
    fs.writeFileSync(path.join(tempDir, 'node_modules', 'dep.js'), 'content');
    const files = await walkDirectory(tempDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain('file.ts');
  });

  test('skips binary file extensions', async () => {
    fs.writeFileSync(path.join(tempDir, 'image.png'), 'fake png content');
    fs.writeFileSync(path.join(tempDir, 'script.ts'), 'real content');
    const files = await walkDirectory(tempDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain('script.ts');
  });
});
