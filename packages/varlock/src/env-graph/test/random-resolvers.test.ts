/**
 * Tests for random value generator resolver functions:
 * randomInt(), randomFloat(), randomUuid(), randomHex(), randomString()
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

describe('randomInt()', () => {
  it('generates an integer with no args (0 to int32 max)', async () => {
    const g = await loadAndResolve('A=randomInt()');
    const val = g.configSchema.A.resolvedValue as number;
    expect(Number.isInteger(val)).toBe(true);
    expect(val).toBeGreaterThanOrEqual(0);
  });

  it('generates an integer with max only', async () => {
    const g = await loadAndResolve('A=randomInt(10)');
    const val = g.configSchema.A.resolvedValue as number;
    expect(Number.isInteger(val)).toBe(true);
    expect(val).toBeGreaterThanOrEqual(0);
    expect(val).toBeLessThanOrEqual(10);
  });

  it('generates an integer in range', async () => {
    const g = await loadAndResolve('A=randomInt(5, 10)');
    const val = g.configSchema.A.resolvedValue as number;
    expect(Number.isInteger(val)).toBe(true);
    expect(val).toBeGreaterThanOrEqual(5);
    expect(val).toBeLessThanOrEqual(10);
  });

  it('rejects min > max', async () => {
    const g = await loadAndResolve('A=randomInt(10, 5)');
    expect(g.configSchema.A.errors.length).toBeGreaterThan(0);
    expect(g.configSchema.A.errors[0]).toBeInstanceOf(SchemaError);
  });

  it('rejects non-integer args', async () => {
    const g = await loadAndResolve('A=randomInt(1.5, 10)');
    expect(g.configSchema.A.errors.length).toBeGreaterThan(0);
  });
});

describe('randomFloat()', () => {
  it('generates a float with no args (0 to 1)', async () => {
    const g = await loadAndResolve('A=randomFloat()');
    const val = g.configSchema.A.resolvedValue as number;
    expect(typeof val).toBe('number');
    expect(val).toBeGreaterThanOrEqual(0);
    expect(val).toBeLessThanOrEqual(1);
  });

  it('generates a float in range', async () => {
    const g = await loadAndResolve('A=randomFloat(10, 20)');
    const val = g.configSchema.A.resolvedValue as number;
    expect(val).toBeGreaterThanOrEqual(10);
    expect(val).toBeLessThanOrEqual(20);
  });

  it('respects precision option', async () => {
    const g = await loadAndResolve('A=randomFloat(0, 1, precision=4)');
    const val = g.configSchema.A.resolvedValue as number;
    const decimalPlaces = val.toString().split('.')[1]?.length ?? 0;
    expect(decimalPlaces).toBeLessThanOrEqual(4);
  });

  it('rejects min > max', async () => {
    const g = await loadAndResolve('A=randomFloat(20, 10)');
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
  it('generates a hex string with default length (32 chars = 16 bytes)', async () => {
    const g = await loadAndResolve('A=randomHex()');
    const val = g.configSchema.A.resolvedValue as string;
    expect(val).toMatch(/^[0-9a-f]{32}$/);
  });

  it('generates a hex string with custom byte length', async () => {
    const g = await loadAndResolve('A=randomHex(8)');
    const val = g.configSchema.A.resolvedValue as string;
    expect(val).toMatch(/^[0-9a-f]{16}$/); // 8 bytes = 16 hex chars
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

  it('rejects zero length', async () => {
    const g = await loadAndResolve('A=randomString(0)');
    expect(g.configSchema.A.errors.length).toBeGreaterThan(0);
  });

  it('rejects empty charset', async () => {
    const g = await loadAndResolve("A=randomString(10, charset='')");
    expect(g.configSchema.A.errors.length).toBeGreaterThan(0);
  });
});
