import { describe, it, expect } from 'vitest';
import * as acorn from 'acorn';

import { createReplacerTransformFn } from '../src/ast-replacer';

// mirrors the estree-compliant parse fn the vite integration passes in
const parserCtx = {
  parse: (code: string) => acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' }),
};

function runReplacer(code: string, id: string) {
  const transform = createReplacerTransformFn({
    replacements: {
      'ENV.PUBLIC_VAR': JSON.stringify('public-var-value'),
      'ENV.GREETING': JSON.stringify('hello'),
    },
  });
  const result = transform(parserCtx, code, id);
  return result ? result.toString() : null;
}

describe('createReplacerTransformFn', () => {
  it('replaces plain member expressions', () => {
    expect(runReplacer('const x = ENV.PUBLIC_VAR;', 'file.ts'))
      .toBe('const x = "public-var-value";');
  });

  it('does not touch references inside strings or comments', () => {
    expect(runReplacer('const x = "ENV.PUBLIC_VAR"; // ENV.PUBLIC_VAR', 'file.ts')).toBe(null);
  });

  it('skips unsupported file types', () => {
    expect(runReplacer('const x = ENV.PUBLIC_VAR;', 'file.css')).toBe(null);
  });

  describe('vue compiled template output', () => {
    it('replaces $setup access (dev / non-inline render fns)', () => {
      expect(runReplacer('_toDisplayString($setup.ENV.GREETING)', 'page.vue'))
        .toBe('_toDisplayString("hello")');
    });

    it('replaces _unref-wrapped access (prod / inline mode)', () => {
      expect(runReplacer('_toDisplayString(_unref(ENV).GREETING)', 'page.vue'))
        .toBe('_toDisplayString("hello")');
    });

    it('leaves bare unref calls alone (user-authored, not vue codegen)', () => {
      expect(runReplacer('const x = unref(ENV).GREETING;', 'page.vue')).toBe(null);
    });

    it('handles multiple access styles in the same module', () => {
      const code = [
        'const a = ENV.PUBLIC_VAR;',
        'const b = _unref(ENV).GREETING;',
      ].join('\n');
      expect(runReplacer(code, 'page.vue')).toBe([
        'const a = "public-var-value";',
        'const b = "hello";',
      ].join('\n'));
    });

    it('does not apply vue-only patterns to non-vue files', () => {
      expect(runReplacer('const x = _unref(ENV).GREETING;', 'file.ts')).toBe(null);
    });

    it('does not touch unref calls on other objects', () => {
      expect(runReplacer('const x = _unref(OTHER).GREETING;', 'page.vue')).toBe(null);
    });
  });
});
