/**
 * Tests for random value generator resolver functions:
 * randomNum(), randomUuid(), randomHex(), randomString()
 */

import { describe, it, expect } from 'vitest';
import { outdent } from 'outdent';
import { DotEnvFileDataSource, EnvGraph } from '../index';
import { SchemaError } from '../lib/errors';

async function loadAndResolve(envContent: string) {
  const g = new EnvGraph();
  const source = new DotEnvFileDataSource('.env.schema', {
    overrideContents: outdent`
      # @defaultRequired=false
      # ---
      ${envContent}
    `,
  });
  await g.setRootDataSource(source);
  await g.finishLoad();
  await g.resolveEnvValues();
  return g;
}

describe('randomNum() — integer mode', () => {
  it('requires at least one arg', async () => {
    const g = await loadAndResolve('A=randomNum()');
    expect(g.configSchema.A.errors.length).toBeGreaterThan(0);
  });

  it('generates an integer with max only (0..max)', async () => {
    const g = await loadAndResolve('A=randomNum(10)');
    const val = g.configSchema.A.resolvedValue as number;
    expect(Number.isInteger(val)).toBe(true);
    expect(val).toBeGreaterThanOrEqual(0);
    expect(val).toBeLessThanOrEqual(10);
  });

  it('generates an integer in range', async () => {
    const g = await loadAndResolve('A=randomNum(5, 10)');
    const val = g.configSchema.A.resolvedValue as number;
    expect(Number.isInteger(val)).toBe(true);
    expect(val).toBeGreaterThanOrEqual(5);
    expect(val).toBeLessThanOrEqual(10);
  });

  it('rejects min > max', async () => {
    const g = await loadAndResolve('A=randomNum(10, 5)');
    expect(g.configSchema.A.errors.length).toBeGreaterThan(0);
    expect(g.configSchema.A.errors[0]).toBeInstanceOf(SchemaError);
  });

  it('rejects non-integer args when precision is not set', async () => {
    const g = await loadAndResolve('A=randomNum(1.5, 10)');
    expect(g.configSchema.A.errors.length).toBeGreaterThan(0);
  });
});

describe('randomNum() — float mode', () => {
  it('returns a float when precision is set', async () => {
    const g = await loadAndResolve('A=randomNum(0, 1, precision=4)');
    const val = g.configSchema.A.resolvedValue as number;
    expect(typeof val).toBe('number');
    expect(val).toBeGreaterThanOrEqual(0);
    expect(val).toBeLessThanOrEqual(1);
    const decimalPlaces = val.toString().split('.')[1]?.length ?? 0;
    expect(decimalPlaces).toBeLessThanOrEqual(4);
  });

  it('allows non-integer bounds when precision is set', async () => {
    const g = await loadAndResolve('A=randomNum(1.5, 10.5, precision=2)');
    const val = g.configSchema.A.resolvedValue as number;
    expect(val).toBeGreaterThanOrEqual(1.5);
    expect(val).toBeLessThanOrEqual(10.5);
  });

  it('rejects negative precision', async () => {
    const g = await loadAndResolve('A=randomNum(0, 1, precision=-1)');
    expect(g.configSchema.A.errors.length).toBeGreaterThan(0);
  });

  it('rejects precision above 20', async () => {
    const g = await loadAndResolve('A=randomNum(0, 1, precision=100)');
    expect(g.configSchema.A.errors.length).toBeGreaterThan(0);
  });
});

describe('randomUuid()', () => {
  it('generates a valid UUID v4', async () => {
    const g = await loadAndResolve('A=randomUuid()');
    const val = g.configSchema.A.resolvedValue as string;
    expect(val).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('generates unique values', async () => {
    const g = await loadAndResolve(outdent`
      A=randomUuid()
      B=randomUuid()
    `);
    expect(g.configSchema.A.resolvedValue).not.toBe(g.configSchema.B.resolvedValue);
  });
});

describe('randomHex()', () => {
  it('generates a hex string with default length (32 chars)', async () => {
    const g = await loadAndResolve('A=randomHex()');
    const val = g.configSchema.A.resolvedValue as string;
    expect(val).toMatch(/^[0-9a-f]{32}$/);
  });

  it('treats the length arg as character count by default', async () => {
    const g = await loadAndResolve('A=randomHex(16)');
    const val = g.configSchema.A.resolvedValue as string;
    expect(val).toMatch(/^[0-9a-f]{16}$/);
  });

  it('supports odd character lengths', async () => {
    const g = await loadAndResolve('A=randomHex(33)');
    const val = g.configSchema.A.resolvedValue as string;
    expect(val).toMatch(/^[0-9a-f]{33}$/);
  });

  it('treats the length arg as byte count when bytes=true', async () => {
    const g = await loadAndResolve('A=randomHex(8, bytes=true)');
    const val = g.configSchema.A.resolvedValue as string;
    expect(val).toMatch(/^[0-9a-f]{16}$/);
  });

  it('rejects zero length', async () => {
    const g = await loadAndResolve('A=randomHex(0)');
    expect(g.configSchema.A.errors.length).toBeGreaterThan(0);
  });
});

describe('randomString()', () => {
  it('generates a string with default length (16) and charset', async () => {
    const g = await loadAndResolve('A=randomString()');
    const val = g.configSchema.A.resolvedValue as string;
    expect(val.length).toBe(16);
    expect(val).toMatch(/^[A-Za-z0-9]+$/);
  });

  it('generates a string with custom length', async () => {
    const g = await loadAndResolve('A=randomString(32)');
    const val = g.configSchema.A.resolvedValue as string;
    expect(val.length).toBe(32);
  });

  it('generates a string with custom charset', async () => {
    const g = await loadAndResolve('A=randomString(10, charset="abc")');
    const val = g.configSchema.A.resolvedValue as string;
    expect(val.length).toBe(10);
    expect(val).toMatch(/^[abc]+$/);
  });

  it('produces unbiased output for charsets that do not divide 256', async () => {
    // 62-char default charset → 256 % 62 = 8 → without rejection sampling, chars 0-7 would be ~1.56x more likely
    const g = new EnvGraph();
    const source = new DotEnvFileDataSource('.env.schema', {
      overrideContents: outdent`
        # @defaultRequired=false
        # ---
        A=randomString(10000)
      `,
    });
    await g.setRootDataSource(source);
    await g.finishLoad();
    await g.resolveEnvValues();
    const val = g.configSchema.A.resolvedValue as string;
    const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const counts = new Map<string, number>();
    for (const c of val) counts.set(c, (counts.get(c) ?? 0) + 1);
    const expectedAvg = val.length / charset.length; // ~161
    // each char should land within ±30% of expected (very loose bound; statistical safety)
    for (const c of charset) {
      const observed = counts.get(c) ?? 0;
      expect(observed).toBeGreaterThan(expectedAvg * 0.7);
      expect(observed).toBeLessThan(expectedAvg * 1.3);
    }
  });

  it('rejects zero length', async () => {
    const g = await loadAndResolve('A=randomString(0)');
    expect(g.configSchema.A.errors.length).toBeGreaterThan(0);
  });

  it('rejects empty charset', async () => {
    const g = await loadAndResolve("A=randomString(10, charset='')");
    expect(g.configSchema.A.errors.length).toBeGreaterThan(0);
  });
});
