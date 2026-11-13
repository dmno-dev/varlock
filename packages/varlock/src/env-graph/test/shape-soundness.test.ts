import { describe, test, expect } from 'vitest';
import { loadGraph } from './type-generation/helpers';

// What shape mode promises, checked on generated schemas: for every item, a shape load either says the value
// is unknown, or gives exactly what a normal load gives (the value and its errors). The same goes for
// required and sensitive, unless shape mode flags that one as unknown.
//
// Two things a normal load does are not held against it:
// - a skipped resolver is assumed to succeed with some value. One that fails makes every item that depends
//   on it invalid, which no static answer can match, so the generated commands never fail.
// - an item that is invalid for certain may be missing further errors that depend on something skipped, but
//   every error a shape load reports has to be one the normal load reports too.

/** small seeded generator (mulberry32), so a failure can be replayed from its seed */
/* eslint-disable no-bitwise -- the generator is bit arithmetic */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    chance: (p: number) => next() < p,
    pick: <T>(xs: ReadonlyArray<T>): T => xs[Math.floor(next() * xs.length)],
    int: (n: number) => Math.floor(next() * n),
  };
}
/* eslint-enable no-bitwise */
type Rng = ReturnType<typeof rng>;

const KEYS = ['A', 'B', 'C', 'D', 'E'];
const LITERALS = ['"a"', '"b"', '""', 'true', 'false', '"true"', 'undefined'];
// each prints something and exits 0 in sh and in cmd.exe
const COMMANDS = ['echo a', 'echo b', 'echo true'];

function genExpr(r: Rng, depth: number): string {
  const leaf = () => {
    if (r.chance(0.2)) return `exec("${r.pick(COMMANDS)}")`;
    return r.chance(0.5) ? `$${r.pick(KEYS)}` : r.pick(LITERALS);
  };
  if (depth === 0 || r.chance(0.35)) return leaf();
  const sub = () => genExpr(r, depth - 1);
  switch (r.int(4)) {
    case 0: return `concat(${sub()}, ${sub()})`;
    case 1: return `fallback(${sub()}, ${sub()})`;
    case 2: return `eq(${sub()}, ${sub()})`;
    default: return `if(eq(${sub()}, ${sub()}), ${sub()}, ${sub()})`;
  }
}

function genFiles(r: Rng): Record<string, string> {
  const header = '# @defaultRequired=false @defaultSensitive=false\n# ---\n';
  const files: Record<string, string> = {};
  const names = ['.env.schema'];
  if (r.chance(0.4)) names.push('.env');
  if (r.chance(0.3)) names.push('.env.local');
  for (const name of names) {
    const lines: Array<string> = [];
    for (const key of KEYS) {
      if (!r.chance(name === '.env.schema' ? 0.75 : 0.35)) continue;
      if (name === '.env.schema' && r.chance(0.6)) {
        const cond = () => (r.chance(0.5) ? `exec("${r.pick(COMMANDS)}")` : `$${r.pick(KEYS)}`);
        const decorators: Array<string> = [];
        if (r.chance(0.5)) decorators.push(`@required=eq(${cond()}, ${r.pick(['a', 'b', '""', 'true'])})`);
        if (r.chance(0.5)) decorators.push(`@sensitive=eq(${cond()}, ${r.pick(['a', 'true'])})`);
        if (r.chance(0.3)) {
          decorators.push(`@type=${r.pick(['boolean', 'string(minLength=1)', 'enum(a, b, true)', 'number'])}`);
        }
        if (decorators.length) lines.push(`# ${decorators.join(' ')}`);
      }
      lines.push(r.chance(0.1) ? `${key}=` : `${key}=${genExpr(r, 2)}`);
    }
    files[name] = `${header}${lines.join('\n')}\n`;
  }
  return files;
}

async function summarize(files: Record<string, string>, mode: 'default' | 'shape') {
  const g = await loadGraph({ files, mode, overrideValues: {} });
  await g.resolveEnvValues();
  return Object.fromEntries(g.sortedConfigKeys.map((key) => {
    const item = g.configSchema[key];
    return [
      key, {
        value: item.resolvedValue,
        errors: item.errors.filter((e) => !e.isWarning).map((e) => e.message).sort(),
        required: item.isRequired,
        sensitive: item.isSensitive,
        valueUnknown: item.isValueUnknownInShapeLoad,
        requiredUnknown: item.isRequiredUnknownInShapeLoad,
        sensitiveUnknown: item.isSensitiveUnknownInShapeLoad,
      },
    ];
  }));
}

describe('shape mode says unknown, or the same as a normal load', () => {
  test.each([1, 2, 3, 4, 5, 6])('200 generated schemas, seed %i', async (seed) => {
    const r = rng(seed);
    let known = 0;
    for (let i = 0; i < 200; i++) {
      const files = genFiles(r);
      const normal = await summarize(files, 'default');
      const shape = await summarize(files, 'shape');
      const where = `seed ${seed}, schema ${i}:\n${Object.entries(files).map(([name, text]) => `[${name}]\n${text}`).join('')}`;
      expect(Object.keys(shape).sort(), where).toEqual(Object.keys(normal).sort());
      for (const [key, n] of Object.entries(normal)) {
        const s = shape[key];
        if (!s.valueUnknown) {
          known++;
          expect(s.value, `${key} value, ${where}`).toEqual(n.value);
          if (s.errors.length && n.errors.length) {
            expect(n.errors, `${key} errors, ${where}`).toEqual(expect.arrayContaining(s.errors));
          } else {
            expect(s.errors, `${key} errors, ${where}`).toEqual(n.errors);
          }
        }
        // a normal load leaves required and sensitive at their initial values on an item that failed
        if (n.errors.length) continue;
        if (!s.requiredUnknown) expect(s.required, `${key} required, ${where}`).toBe(n.required);
        if (!s.sensitiveUnknown) expect(s.sensitive, `${key} sensitive, ${where}`).toBe(n.sensitive);
      }
    }
    // the check means nothing if shape mode calls everything unknown
    expect(known).toBeGreaterThan(300);
  }, 60_000);
});
