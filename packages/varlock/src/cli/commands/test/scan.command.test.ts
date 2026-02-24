import {
  describe, test, expect, beforeEach, afterEach,
} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SECRET_PATTERNS, scanFile } from '../scan.command';

describe('SECRET_PATTERNS', () => {
  test('detects PEM private key', () => {
    const pattern = SECRET_PATTERNS.find((p) => p.id === 'pem-private-key')!;
    expect(pattern.pattern.test('-----BEGIN RSA PRIVATE KEY-----')).toBe(true);
    expect(pattern.pattern.test('-----BEGIN EC PRIVATE KEY-----')).toBe(true);
    expect(pattern.pattern.test('-----BEGIN OPENSSH PRIVATE KEY-----')).toBe(true);
    expect(pattern.pattern.test('-----BEGIN PRIVATE KEY-----')).toBe(true);
    expect(pattern.pattern.test('some random text')).toBe(false);
  });

  test('detects AWS Access Key ID', () => {
    const pattern = SECRET_PATTERNS.find((p) => p.id === 'aws-access-key-id')!;
    expect(pattern.pattern.test('AKIAIOSFODNN7EXAMPLE')).toBe(true);
    expect(pattern.pattern.test('aws_access_key_id = AKIAI44QH8DHBEXAMPLE')).toBe(true);
    expect(pattern.pattern.test('AKIAXYZ123')).toBe(false); // too short
    expect(pattern.pattern.test('not-an-aws-key')).toBe(false);
  });

  test('detects GitHub Token', () => {
    const pattern = SECRET_PATTERNS.find((p) => p.id === 'github-token')!;
    expect(pattern.pattern.test('ghp_abcdefghijklmnopqrstuvwxyz1234567890')).toBe(true);
    expect(pattern.pattern.test('gho_abcdefghijklmnopqrstuvwxyz1234567890')).toBe(true);
    expect(pattern.pattern.test('ghs_abcdefghijklmnopqrstuvwxyz1234567890')).toBe(true);
    expect(pattern.pattern.test('ghr_abcdefghijklmnopqrstuvwxyz1234567890')).toBe(true);
    expect(pattern.pattern.test('not-a-github-token')).toBe(false);
    expect(pattern.pattern.test('ghp_short')).toBe(false); // too short
  });

  test('detects GitHub Fine-Grained Personal Access Token', () => {
    const pattern = SECRET_PATTERNS.find((p) => p.id === 'github-fine-grained-pat')!;
    const validToken = `github_pat_${'a'.repeat(82)}`;
    expect(pattern.pattern.test(validToken)).toBe(true);
    expect(pattern.pattern.test('github_pat_short')).toBe(false);
    expect(pattern.pattern.test('not-a-github-token')).toBe(false);
  });

  test('detects Slack Token', () => {
    const pattern = SECRET_PATTERNS.find((p) => p.id === 'slack-token')!;
    expect(pattern.pattern.test('xoxb-123456789012-123456789012-abcdefghijklmnopqrst')).toBe(true);
    expect(pattern.pattern.test('xoxp-1234567890-1234567890-abcdefghijk')).toBe(true);
    expect(pattern.pattern.test('not-a-slack-token')).toBe(false);
    expect(pattern.pattern.test('xoxb-short')).toBe(false); // too short
  });

  test('detects URL with embedded credentials', () => {
    const pattern = SECRET_PATTERNS.find((p) => p.id === 'url-with-credentials')!;
    expect(pattern.pattern.test('https://user:mypassword123@api.example.com')).toBe(true);
    expect(pattern.pattern.test('http://admin:secret_token@db.internal:5432')).toBe(true);
    expect(pattern.pattern.test('https://api.example.com/path')).toBe(false); // no credentials
    expect(pattern.pattern.test('https://user:short@host')).toBe(false); // password too short (< 8 chars)
  });
});

describe('scanFile', () => {
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
    const findings = await scanFile(filePath);
    expect(findings).toHaveLength(0);
  });

  test('detects AWS key in file', async () => {
    const filePath = path.join(tempDir, 'config.ts');
    fs.writeFileSync(filePath, 'const awsKey = "AKIAIOSFODNN7EXAMPLE";\n');
    const findings = await scanFile(filePath);
    expect(findings).toHaveLength(1);
    expect(findings[0].patternId).toBe('aws-access-key-id');
    expect(findings[0].lineNumber).toBe(1);
  });

  test('detects multiple secrets across multiple lines', async () => {
    const filePath = path.join(tempDir, 'secrets.ts');
    fs.writeFileSync(filePath, [
      'const awsKey = "AKIAIOSFODNN7EXAMPLE";',
      'const dbUrl = "https://admin:mypassword123@db.example.com";',
      'const normalVar = "hello";',
    ].join('\n'));
    const findings = await scanFile(filePath);
    expect(findings).toHaveLength(2);
    expect(findings[0].patternId).toBe('aws-access-key-id');
    expect(findings[0].lineNumber).toBe(1);
    expect(findings[1].patternId).toBe('url-with-credentials');
    expect(findings[1].lineNumber).toBe(2);
  });

  test('detects PEM private key in file', async () => {
    const filePath = path.join(tempDir, 'key.pem');
    fs.writeFileSync(filePath, '-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----\n');
    const findings = await scanFile(filePath);
    expect(findings).toHaveLength(1);
    expect(findings[0].patternId).toBe('pem-private-key');
    expect(findings[0].lineNumber).toBe(1);
  });

  test('returns no findings for a non-existent file', async () => {
    const findings = await scanFile(path.join(tempDir, 'does-not-exist.ts'));
    expect(findings).toHaveLength(0);
  });

  test('skips binary files (files with null bytes)', async () => {
    const filePath = path.join(tempDir, 'binary.bin');
    // 'AKIA' bytes (start of AWS key pattern) + null byte to simulate binary file
    // Without the null byte, 'AKIAIOSFODNN7EXAMPLE' would match the AWS key pattern
    fs.writeFileSync(filePath, Buffer.from([0x41, 0x4b, 0x49, 0x41, 0x00, 0x49, 0x4f]));
    const findings = await scanFile(filePath);
    // Verify that the null byte causes the file to be skipped (no findings)
    expect(findings).toHaveLength(0);

    // Confirm the same content without the null byte WOULD be detected
    const textFilePath = path.join(tempDir, 'text-with-aws-key.ts');
    fs.writeFileSync(textFilePath, 'AKIAIOSFODNN7EXAMPLE');
    const textFindings = await scanFile(textFilePath);
    expect(textFindings).toHaveLength(1);
    expect(textFindings[0].patternId).toBe('aws-access-key-id');
  });

  test('only reports one finding per line even if multiple patterns match', async () => {
    const filePath = path.join(tempDir, 'multi.env');
    // A line with a GitHub token
    fs.writeFileSync(filePath, 'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz1234567890\n');
    const findings = await scanFile(filePath);
    expect(findings).toHaveLength(1);
    expect(findings[0].lineNumber).toBe(1);
  });
});
