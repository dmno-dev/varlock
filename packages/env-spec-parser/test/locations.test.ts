import { describe, it, expect } from 'vitest';
import {
  parseEnvSpecDotEnvFile, ParsedEnvSpecConfigItem, ParsedEnvSpecDecorator,
} from '../src';

const LF_SOURCE = [
  '# header comment',
  '# @defaultRequired=false',
  '',
  '# a comment',
  '# @type=string(minLength=2) @sensitive',
  'FOO=foo # trailing comment',
  'BAR="multi',
  'line"',
  'BAZ=concat(one, "two")',
  '',
].join('\n');
const CRLF_SOURCE = LF_SOURCE.replaceAll('\n', '\r\n');

type Pos = { offset: number; line: number; column: number };
type Loc = { start: Pos; end: Pos };

/** collects every `_location` found anywhere in the parsed tree */
function collectLocations(node: unknown, out: Array<Loc> = [], seen = new Set<unknown>()): Array<Loc> {
  if (!node || typeof node !== 'object' || seen.has(node)) return out;
  seen.add(node);
  for (const [key, val] of Object.entries(node)) {
    if (key === '_location' && val) out.push(val as Loc);
    else collectLocations(val, out, seen);
  }
  return out;
}

describe('node locations', () => {
  it('are offsets into the input when it uses \\r\\n', () => {
    const parsed = parseEnvSpecDotEnvFile(CRLF_SOURCE);
    const items = parsed.contents.filter((c) => c instanceof ParsedEnvSpecConfigItem);
    expect(items.map((i) => i.key)).toEqual(['FOO', 'BAR', 'BAZ']);

    for (const item of items) {
      const loc = item.data._location as Loc;
      // the item starts at its pre-comments and its source text contains its own `KEY=`
      const text = CRLF_SOURCE.slice(loc.start.offset, loc.end.offset);
      expect(text).toContain(`${item.key}=`);
    }

    // value locations point right at the value text
    const bar = items.find((i) => i.key === 'BAR')!;
    const barLoc = bar.data.value!.data._location as Loc;
    expect(CRLF_SOURCE.slice(barLoc.start.offset, barLoc.end.offset)).toBe('"multi\r\nline"');
    const baz = items.find((i) => i.key === 'BAZ')!;
    const bazLoc = baz.data.value!.data._location as Loc;
    expect(CRLF_SOURCE.slice(bazLoc.start.offset, bazLoc.end.offset)).toBe('concat(one, "two")');
  });

  it('point at decorators when the input uses \\r\\n', () => {
    const parsed = parseEnvSpecDotEnvFile(CRLF_SOURCE);
    const decs: Array<ParsedEnvSpecDecorator> = [
      ...parsed.decoratorsArray,
      ...parsed.configItems.flatMap((i) => i.decoratorsArray),
    ];
    expect(decs.map((d) => d.name)).toEqual(['defaultRequired', 'type', 'sensitive']);
    for (const dec of decs) {
      const loc = dec.data._location as Loc;
      expect(CRLF_SOURCE.slice(loc.start.offset, loc.end.offset)).toMatch(new RegExp(`^@${dec.name}`));
    }
  });

  it('only differ from the \\n version by the \\r characters before them', () => {
    const lfLocs = collectLocations(parseEnvSpecDotEnvFile(LF_SOURCE));
    const crlfLocs = collectLocations(parseEnvSpecDotEnvFile(CRLF_SOURCE));
    expect(lfLocs.length).toBeGreaterThan(10);
    expect(crlfLocs.length).toBe(lfLocs.length);
    lfLocs.forEach((lf, i) => {
      const crlf = crlfLocs[i];
      for (const edge of ['start', 'end'] as const) {
        // line and column are the same, and every earlier line break added one `\r`
        expect(crlf[edge].line).toBe(lf[edge].line);
        expect(crlf[edge].column).toBe(lf[edge].column);
        expect(crlf[edge].offset).toBe(lf[edge].offset + (lf[edge].line - 1));
      }
    });
  });

  it('do not change the parsed values', () => {
    const values = (src: string) => parseEnvSpecDotEnvFile(src).configItems.map((i) => i.data.value?.toString());
    expect(values(CRLF_SOURCE)).toEqual(values(LF_SOURCE));
    expect(values(CRLF_SOURCE)[1]).toBe('"multi\nline"');
  });

  it('are unchanged when the input uses \\n', () => {
    const parsed = parseEnvSpecDotEnvFile('FOO=foo\nBAR=bar\n');
    const [foo, bar] = parsed.configItems;
    expect(foo.data._location.start.offset).toBe(0);
    expect(foo.data._location.end.offset).toBe(8);
    expect(bar.data._location.start.offset).toBe(8);
    expect(bar.data._location.end.offset).toBe(16);
  });

  it('are correct for mixed line endings', () => {
    const src = 'FOO=foo\r\nBAR=bar\nBAZ=baz\r\n';
    const parsed = parseEnvSpecDotEnvFile(src);
    const slices = parsed.configItems.map((i) => {
      const loc = i.data.value!.data._location as Loc;
      return src.slice(loc.start.offset, loc.end.offset);
    });
    expect(slices).toEqual(['foo', 'bar', 'baz']);
  });
});

describe('syntax error locations', () => {
  function getError(source: string) {
    try {
      parseEnvSpecDotEnvFile(source);
    } catch (err) {
      return err as Error & { location: Loc };
    }
    throw new Error('expected a syntax error');
  }

  it('are offsets into the input when it uses \\r\\n', () => {
    const lfSource = 'A=1\nB=2\n@oops\n';
    const crlfSource = lfSource.replaceAll('\n', '\r\n');
    const lfError = getError(lfSource);
    const crlfError = getError(crlfSource);
    expect(crlfError.location.start.line).toBe(lfError.location.start.line);
    expect(crlfError.location.start.column).toBe(lfError.location.start.column);
    expect(crlfError.location.start.offset).toBe(lfError.location.start.offset + 2);
    expect(crlfSource.slice(crlfError.location.start.offset)).toMatch(/^@/);
  });

  it.each([
    ['at the end of the input', 'A=1\nB=2\n# @type='],
    ['after a trailing line break', 'A=1\n# @a(\n'],
    ['spanning a line break', 'A=1\n# @type=\nB=2\n'],
  ])('have the right start and end offsets for an error %s', (_desc, lfSource) => {
    const crlfSource = lfSource.replaceAll('\n', '\r\n');
    const lfError = getError(lfSource);
    const crlfError = getError(crlfSource);
    for (const edge of ['start', 'end'] as const) {
      expect(crlfError.location[edge].line).toBe(lfError.location[edge].line);
      expect(crlfError.location[edge].column).toBe(lfError.location[edge].column);
      expect(crlfError.location[edge].offset).toBe(lfError.location[edge].offset + (lfError.location[edge].line - 1));
    }
    // sanity check the \n version is in input coordinates already
    expect(lfError.location.end.offset).toBeLessThanOrEqual(lfSource.length);
    expect(crlfError.location.end.offset).toBeLessThanOrEqual(crlfSource.length);
  });

  it('point at the end of the input when the error is at the end of a \\r\\n input', () => {
    const source = 'A=1\r\nB=2\r\n# @type=';
    const { location } = getError(source);
    expect(location.start.offset).toBe(source.length);
    expect(location.end.offset).toBe(source.length);
  });
});
