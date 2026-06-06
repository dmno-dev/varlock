import { describe, it, expect } from 'vitest';
import { parseDuration, convertDurationFromMs } from '../duration';

describe('parseDuration', () => {
  it('parses unit-suffixed strings', () => {
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('5m')).toBe(300_000);
    expect(parseDuration('1h')).toBe(3_600_000);
    expect(parseDuration('1d')).toBe(86_400_000);
    expect(parseDuration('1w')).toBe(604_800_000);
    expect(parseDuration('500ms')).toBe(500);
  });

  it('parses long-form units', () => {
    expect(parseDuration('30seconds')).toBe(30_000);
    expect(parseDuration('5minutes')).toBe(300_000);
    expect(parseDuration('2days')).toBe(172_800_000);
    expect(parseDuration('1hour')).toBe(3_600_000);
    expect(parseDuration('2weeks')).toBe(1_209_600_000);
    expect(parseDuration('1500milliseconds')).toBe(1500);
  });

  it('is case-insensitive on units', () => {
    expect(parseDuration('2H')).toBe(7_200_000);
    expect(parseDuration('2HOURS')).toBe(7_200_000);
  });

  it('tolerates internal whitespace', () => {
    expect(parseDuration('  1h  ')).toBe(3_600_000);
    expect(parseDuration('1 h')).toBe(3_600_000);
  });

  it('parses fractional values', () => {
    expect(parseDuration('1.5h')).toBe(5_400_000);
    expect(parseDuration('0.5d')).toBe(43_200_000);
  });

  it('accepts bare numbers as ms', () => {
    expect(parseDuration('1000')).toBe(1000);
    expect(parseDuration(500)).toBe(500);
    expect(parseDuration(0)).toBe(0);
  });

  it('accepts zero with a unit', () => {
    expect(parseDuration('0s')).toBe(0);
    expect(parseDuration('0h')).toBe(0);
  });

  it('rejects empty/whitespace strings', () => {
    expect(() => parseDuration('')).toThrow();
    expect(() => parseDuration('   ')).toThrow();
  });

  it('rejects unknown units', () => {
    expect(() => parseDuration('5x')).toThrow(/Invalid duration unit/);
    expect(() => parseDuration('5fortnights')).toThrow(/Invalid duration unit/);
  });

  it('rejects non-numeric strings', () => {
    expect(() => parseDuration('abc')).toThrow();
    expect(() => parseDuration('h')).toThrow();
  });

  it('rejects negative values', () => {
    expect(() => parseDuration('-5m')).toThrow();
    expect(() => parseDuration(-100)).toThrow();
  });

  it('rejects non-finite numbers', () => {
    expect(() => parseDuration(Infinity)).toThrow();
    expect(() => parseDuration(NaN)).toThrow();
  });
});

describe('convertDurationFromMs', () => {
  it('converts to common units', () => {
    expect(convertDurationFromMs(3_600_000, 'ms')).toBe(3_600_000);
    expect(convertDurationFromMs(3_600_000, 'seconds')).toBe(3_600);
    expect(convertDurationFromMs(3_600_000, 'minutes')).toBe(60);
    expect(convertDurationFromMs(3_600_000, 'hours')).toBe(1);
  });

  it('returns fractional values when not a whole multiple', () => {
    expect(convertDurationFromMs(90_000, 'minutes')).toBe(1.5);
    expect(convertDurationFromMs(500, 'seconds')).toBe(0.5);
  });
});
