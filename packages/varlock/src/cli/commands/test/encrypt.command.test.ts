import {
  afterEach, beforeEach, describe, expect, test, vi,
} from 'vitest';
import { Readable } from 'node:stream';

vi.mock('../../../lib/local-encrypt', () => ({
  ensureKey: vi.fn(),
  encryptValue: vi.fn(async () => 'encrypted-payload'),
  getBackendInfo: vi.fn(() => ({
    type: 'file-based',
    hardwareBacked: false,
    biometricAvailable: false,
  })),
}));

vi.mock('../../helpers/prompts', () => ({
  multiselect: vi.fn(),
  password: vi.fn(async (opts: { output?: NodeJS.WritableStream }) => {
    (opts.output ?? process.stdout).write('password prompt output');
    return 'test-secret';
  }),
}));

import { password } from '../../helpers/prompts';
import { commandFn } from '../encrypt.command.js';

const originalStdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin')!;
const originalStdin = process.stdin;
const originalStdinIsTTY = process.stdin.isTTY;

describe('encrypt command output format', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(originalStdin, 'isTTY', { configurable: true, value: originalStdinIsTTY });
    Object.defineProperty(process, 'stdin', originalStdinDescriptor);
  });

  test('raw format requires piped stdin rather than prompting interactively', async () => {
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await expect(commandFn({ values: { format: 'raw' } } as any))
      .rejects.toThrow('--format raw requires a value on stdin');

    expect(stdoutWrite).not.toHaveBeenCalled();
    expect(password).not.toHaveBeenCalled();
  });

  test('raw format writes only the varlock expression to stdout when stdin is piped', async () => {
    const stdin = Readable.from([Buffer.from('test-secret')]);
    Object.defineProperty(stdin, 'isTTY', { configurable: true, value: false });
    Object.defineProperty(process, 'stdin', { configurable: true, value: stdin });
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const log = vi.spyOn(console, 'log').mockReturnValue(undefined);
    const error = vi.spyOn(console, 'error').mockReturnValue(undefined);

    await commandFn({ values: { format: 'raw' } } as any);

    expect(stdoutWrite).toHaveBeenCalledExactlyOnceWith('varlock("local:encrypted-payload")\n');
    expect(log).not.toHaveBeenCalled();
    expect(password).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith('Using file-based backend (file-based)');
  });

  test('pretty format keeps the existing copy/paste output', async () => {
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const log = vi.spyOn(console, 'log').mockReturnValue(undefined);

    await commandFn({ values: { format: 'pretty' } } as any);

    expect(stdoutWrite).toHaveBeenCalledWith('password prompt output');
    expect(stdoutWrite.mock.calls.map(([chunk]) => String(chunk)).join(''))
      .toContain('password prompt output');
    expect(log).toHaveBeenCalledWith('SOME_SENSITIVE_KEY=varlock("local:encrypted-payload")');
  });

  test('raw format cannot be combined with --file', async () => {
    await expect(commandFn({ values: { format: 'raw', file: '.env.local' } } as any))
      .rejects.toThrow('--format raw is only available when encrypting a single value');
  });
});
