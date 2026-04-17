import {
  describe, it, expect, beforeEach,
} from 'vitest';
import { scanForLeaks, resetRedactionMap } from '../env';
import type { SerializedEnvGraph } from '../../env-graph';

/** helper to set up redaction state with a known secret */
function setSecret(key: string, value: string) {
  resetRedactionMap({
    config: {
      [key]: { isSensitive: true, value },
    },
  } as unknown as SerializedEnvGraph);
}

describe('scanForLeaks', () => {
  const SECRET_KEY = 'API_KEY';
  const SECRET_VALUE = 'super-secret-value-12345';

  beforeEach(() => {
    setSecret(SECRET_KEY, SECRET_VALUE);
  });

  // --- strings ---
  it('detects a leaked secret in a plain string', () => {
    expect(() => scanForLeaks(`hello ${SECRET_VALUE} world`))
      .toThrow(/DETECTED LEAKED SENSITIVE CONFIG/);
  });

  it('passes a clean string through unchanged', () => {
    const clean = 'nothing secret here';
    expect(scanForLeaks(clean)).toBe(clean);
  });

  // --- Buffer (Node) ---
  it('detects a leaked secret in a Buffer', () => {
    const buf = Buffer.from(`payload ${SECRET_VALUE} end`);
    expect(() => scanForLeaks(buf as any)).toThrow(/DETECTED LEAKED SENSITIVE CONFIG/);
  });

  it('passes a clean Buffer through unchanged', () => {
    const buf = Buffer.from('safe content');
    expect(scanForLeaks(buf as any)).toBe(buf);
  });

  // --- Uint8Array / ArrayBufferView (edge runtimes like Cloudflare Workers) ---
  it('detects a leaked secret in a Uint8Array', () => {
    const encoder = new TextEncoder();
    const arr = encoder.encode(`payload ${SECRET_VALUE} end`);
    expect(() => scanForLeaks(arr as any)).toThrow(/DETECTED LEAKED SENSITIVE CONFIG/);
  });

  it('passes a clean Uint8Array through unchanged', () => {
    const encoder = new TextEncoder();
    const arr = encoder.encode('safe content');
    expect(scanForLeaks(arr as any)).toBe(arr);
  });

  // --- ReadableStream ---
  it('detects a leaked secret in a ReadableStream chunk', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data ${SECRET_VALUE}`));
        controller.close();
      },
    });

    const scanned = scanForLeaks(stream as any) as ReadableStream;
    const reader = scanned.getReader();

    await expect(reader.read()).rejects.toThrow(/DETECTED LEAKED SENSITIVE CONFIG/);
  });

  it('passes a clean ReadableStream through', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('safe'));
        controller.close();
      },
    });

    const scanned = scanForLeaks(stream as any) as ReadableStream;
    const reader = scanned.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toBe('safe');
  });

  // --- null / undefined ---
  it('returns null for null input', () => {
    expect(scanForLeaks(null)).toBeNull();
  });
});
