import {
  afterEach, beforeEach, describe, expect, test, vi,
} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { commandFn } from '../audit.command';

const {
  gracefulExitMock,
  scanCodeForEnvVarsMock,
} = vi.hoisted(() => ({
  gracefulExitMock: vi.fn(),
  scanCodeForEnvVarsMock: vi.fn(),
}));
let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

// Only the process boundary (exit) and the scanner input are faked: the
// schema text goes through the real parser, decorator resolution and command
// wiring. This is the seam a mocked dec.resolve() cannot cover — it is what
// let the first draft document a form the parser rejects.
vi.mock('exit-hook', () => ({ gracefulExit: gracefulExitMock }));
vi.mock('../../helpers/env-var-scanner', () => ({ scanCodeForEnvVars: scanCodeForEnvVarsMock }));

describe('audit @auditExtraPatterns end to end', () => {
  let tempDir: string;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    gracefulExitMock.mockReset();
    scanCodeForEnvVarsMock.mockReset();

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-audit-extra-'));
    fs.mkdirSync(path.join(tempDir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, '.env.schema'), [
      // NOTE: inner quotes must be backslash-escaped — a bare '...' inside
      // would terminate the DSL string and fail parsing outright.
      `# @auditExtraPatterns(regex('config\\.get\\(\\s*\\'([A-Z_]+)\\'\\)'))`,
      '# ---',
      'APP_ID=',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(tempDir, '.env'), 'APP_ID=abc\n');
    fs.writeFileSync(path.join(tempDir, 'config', 'app.ts'), 'const id = config.get(\'APP_ID\');\n');
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('documented regex() form reaches the scanner as a usable regex', async () => {
    scanCodeForEnvVarsMock.mockResolvedValue({
      keys: ['APP_ID'],
      references: [],
      scannedFilesCount: 1,
    });

    await commandFn({ values: { path: tempDir } } as any);

    expect(scanCodeForEnvVarsMock).toHaveBeenCalledTimes(1);
    const options = scanCodeForEnvVarsMock.mock.calls[0]?.[0] as
      | { extraPatterns?: Array<RegExp> }
      | undefined;
    expect(options?.extraPatterns).toHaveLength(1);
    // Single backslashes at runtime: the DSL unescaped \' but kept \. \( \s.
    expect(options?.extraPatterns?.[0]?.source).toBe(`config\\.get\\(\\s*'([A-Z_]+)'\\)`);
    expect(gracefulExitMock).toHaveBeenCalledWith(0);
  });
});
