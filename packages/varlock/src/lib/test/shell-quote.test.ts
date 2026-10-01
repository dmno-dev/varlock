import { describe, expect, test } from 'vitest';
import { execSync } from 'node:child_process';
import { shellQuoteWord } from '../shell-quote';

describe('shellQuoteWord (posix)', () => {
  const q = (v: string) => shellQuoteWord(v, 'linux');

  test('leaves plainly safe values bare', () => {
    expect(q('dev')).toBe('dev');
    expect(q('op://vault/item/field')).toBe('op://vault/item/field');
    expect(q('--flag=value,other+1%')).toBe('--flag=value,other+1%');
  });

  test('quotes anything the shell could interpret', () => {
    expect(q('')).toBe("''");
    expect(q('dev; rm -rf /')).toBe("'dev; rm -rf /'");
    expect(q('$(whoami)')).toBe("'$(whoami)'");
    expect(q('a b')).toBe("'a b'");
    expect(q('~user')).toBe("'~user'");
    expect(q('*.txt')).toBe("'*.txt'");
    expect(q('it\'s')).toBe("'it'\\''s'");
    expect(q('back\\slash')).toBe("'back\\slash'");
  });

  test.skipIf(process.platform === 'win32')('round-trips through /bin/sh as a single argument', () => {
    const values = ['dev; echo pwned', '$(echo pwned)', '`echo pwned`', 'a  b', 'it\'s "quoted"', '', '*', '-n'];
    for (const value of values) {
      const out = execSync(`printf '[%s]' ${q(value)}`, { encoding: 'utf8' });
      expect(out).toBe(`[${value}]`);
    }
  });
});

describe('shellQuoteWord (win32)', () => {
  test('uses cmd.exe double-quote escaping', () => {
    expect(shellQuoteWord('dev', 'win32')).toBe('"dev"');
    expect(shellQuoteWord('', 'win32')).toBe('""');
    expect(shellQuoteWord('say "hi" & del x', 'win32')).toBe('"say ""hi"" & del x"');
  });
});
