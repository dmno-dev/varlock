import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import { resetRedactionMap, getRedactionHoldbackLength } from '../env';
import { createRedactedStreamWriter } from '../lib/redact-stream';
import type { SerializedEnvGraph } from '../../env-graph';

/** helper to set up redaction state with known secrets */
function setSecrets(secrets: Record<string, string>) {
  resetRedactionMap({
    config: Object.fromEntries(
      Object.entries(secrets).map(([key, value]) => [key, { isSensitive: true, value }]),
    ),
  } as unknown as SerializedEnvGraph);
}

const SECRET_VALUE = 'super-secret-value-12345';
const REDACTED_SECRET = 'su▒▒▒▒▒';

describe('getRedactionHoldbackLength', () => {
  beforeEach(() => {
    setSecrets({ API_KEY: SECRET_VALUE });
  });

  it('returns 0 when output does not end with a partial secret', () => {
    expect(getRedactionHoldbackLength('nothing to see here')).toBe(0);
  });

  it('returns 0 for empty string', () => {
    expect(getRedactionHoldbackLength('')).toBe(0);
  });

  it('returns 0 when a full secret is at the end (normal redaction will catch it)', () => {
    expect(getRedactionHoldbackLength(`key=${SECRET_VALUE}`)).toBe(0);
  });

  it('returns the length of a partial secret at the end', () => {
    expect(getRedactionHoldbackLength('key=super-secr')).toBe('super-secr'.length);
  });

  it('returns the longest partial match', () => {
    setSecrets({ A: 'super-secret-AAA', B: 'secret-BBB' });
    // 'super-secret-' is a prefix of A (len 13), while 'secret-' is a prefix of B (len 7)
    expect(getRedactionHoldbackLength('xx super-secret-')).toBe('super-secret-'.length);
  });

  it('returns 0 when there are no sensitive values', () => {
    setSecrets({});
    expect(getRedactionHoldbackLength('super-secr')).toBe(0);
  });
});

describe('createRedactedStreamWriter', () => {
  let written: Array<string>;
  const fakeStream = { write: (str: string) => written.push(str) };

  beforeEach(() => {
    vi.useFakeTimers();
    written = [];
    setSecrets({ API_KEY: SECRET_VALUE });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('redacts a secret contained within a single chunk', () => {
    const writer = createRedactedStreamWriter(fakeStream);
    writer.write(`key=${SECRET_VALUE}\n`);
    expect(written.join('')).toBe(`key=${REDACTED_SECRET}\n`);
  });

  it('redacts a secret split across two chunks', () => {
    const writer = createRedactedStreamWriter(fakeStream);
    writer.write(`key=${SECRET_VALUE.slice(0, 10)}`);
    writer.write(`${SECRET_VALUE.slice(10)}\n`);
    expect(written.join('')).toBe(`key=${REDACTED_SECRET}\n`);
  });

  it('redacts a secret split across many chunks', () => {
    const writer = createRedactedStreamWriter(fakeStream);
    writer.write('key=');
    for (const char of SECRET_VALUE) writer.write(char);
    writer.write('\n');
    expect(written.join('')).toBe(`key=${REDACTED_SECRET}\n`);
  });

  it('handles Buffer chunks', () => {
    const writer = createRedactedStreamWriter(fakeStream);
    writer.write(Buffer.from(`key=${SECRET_VALUE.slice(0, 10)}`));
    writer.write(Buffer.from(`${SECRET_VALUE.slice(10)}\n`));
    expect(written.join('')).toBe(`key=${REDACTED_SECRET}\n`);
  });

  it('does not hold back output that is not a partial secret', () => {
    const writer = createRedactedStreamWriter(fakeStream);
    writer.write('prompt> ');
    expect(written.join('')).toBe('prompt> ');
  });

  it('flushes held-back output after the timeout', () => {
    const writer = createRedactedStreamWriter(fakeStream);
    writer.write('key=super-secr');
    expect(written.join('')).toBe('key=');
    vi.runAllTimers();
    expect(written.join('')).toBe('key=super-secr');
  });

  it('flush() emits any held-back output', () => {
    const writer = createRedactedStreamWriter(fakeStream);
    writer.write('key=super-secr');
    writer.flush();
    expect(written.join('')).toBe('key=super-secr');
  });

  it('passes everything through when redaction map is empty', () => {
    setSecrets({});
    const writer = createRedactedStreamWriter(fakeStream);
    writer.write(`key=${SECRET_VALUE}\n`);
    expect(written.join('')).toBe(`key=${SECRET_VALUE}\n`);
  });
});
