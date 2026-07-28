import { describe, it, expect } from 'vitest';
import { parseTtl } from './ttl-parser';

describe('parseTtl', () => {
  describe('string durations', () => {
    it('parses seconds', () => {
      expect(parseTtl('30s')).toBe(30_000);
    });
    it('parses minutes', () => {
      expect(parseTtl('5m')).toBe(300_000);
    });
    it('parses hours', () => {
      expect(parseTtl('1h')).toBe(3_600_000);
    });
    it('parses days', () => {
      expect(parseTtl('1d')).toBe(86_400_000);
    });
    it('parses weeks', () => {
      expect(parseTtl('1w')).toBe(604_800_000);
    });
    it('handles uppercase units', () => {
      expect(parseTtl('2H')).toBe(7_200_000);
    });
    it('handles whitespace around value', () => {
      expect(parseTtl('  1h  ')).toBe(3_600_000);
    });
    it('handles fractional values', () => {
      expect(parseTtl('1.5h')).toBe(5_400_000);
    });
    it('parses "hr" shorthand', () => {
      expect(parseTtl('1hr')).toBe(3_600_000);
    });
    it('parses "hrs" shorthand', () => {
      expect(parseTtl('2hrs')).toBe(7_200_000);
    });
    it('parses "min" shorthand', () => {
      expect(parseTtl('5min')).toBe(300_000);
    });
    it('parses "mins" shorthand', () => {
      expect(parseTtl('10mins')).toBe(600_000);
    });
    it('parses full words', () => {
      expect(parseTtl('1hour')).toBe(3_600_000);
      expect(parseTtl('2days')).toBe(172_800_000);
      expect(parseTtl('1week')).toBe(604_800_000);
      expect(parseTtl('30seconds')).toBe(30_000);
      expect(parseTtl('5minutes')).toBe(300_000);
    });
  });

  describe('bare numbers', () => {
    it('treats bare numbers as milliseconds', () => {
      expect(parseTtl('5000')).toBe(5000);
    });
    it('handles numeric type', () => {
      expect(parseTtl(3000)).toBe(3000);
    });
  });

  describe('forever keyword', () => {
    it('treats "forever" as forever', () => {
      expect(parseTtl('forever')).toBe(Infinity);
    });
    it('is case-insensitive and trims whitespace', () => {
      expect(parseTtl('FOREVER')).toBe(Infinity);
      expect(parseTtl('  forever  ')).toBe(Infinity);
    });
  });

  describe('error cases', () => {
    it('rejects 0 as ambiguous', () => {
      expect(() => parseTtl(0)).toThrow(/ambiguous/);
      expect(() => parseTtl('0')).toThrow(/ambiguous/);
      expect(() => parseTtl('0s')).toThrow(/ambiguous/);
    });
    it('rejects empty string', () => {
      expect(() => parseTtl('')).toThrow();
    });
    it('rejects negative', () => {
      expect(() => parseTtl('-5m')).toThrow();
    });
    it('rejects invalid unit', () => {
      expect(() => parseTtl('5x')).toThrow();
    });
    it('rejects non-numeric string', () => {
      expect(() => parseTtl('abc')).toThrow();
    });
    it('rejects negative numeric', () => {
      expect(() => parseTtl(-100)).toThrow();
    });
    it('rejects non-standard number formats', () => {
      expect(() => parseTtl('1e3')).toThrow();
      expect(() => parseTtl('0x10')).toThrow();
      expect(() => parseTtl('Infinity')).toThrow();
    });
  });
});
