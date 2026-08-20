/*
  AST-based static replacement of expressions (e.g. `ENV.SOME_KEY` -> literal values).

  Used https://www.npmjs.com/package/rollup-plugin-define as a starting point
  Initially we were using @rollup/plugin-replace, but it would replace text in strings

  This instead replaces nodes in a parsed AST rather than text in a string,
  so references inside string literals, comments, and template literal text
  are never touched.

  Shared by the vite integration (which passes rollup's `parse`) and the
  nextjs integration's turbopack loader (which passes @babel/parser).
  The parser just needs to produce an estree-compliant tree with node
  start/end offsets (ast-matcher also accepts @babel/parser `File` nodes).
*/

import MagicString from 'magic-string';
import astMatcher from 'ast-matcher';

type Edit = [number, number];
type AstNode = { start: number; end: number };

/** parse fn producing an estree-compliant AST with start/end offsets on nodes */
export type AstParseFn = (code: string, opts?: any) => any;

function escapeStringRegexp(string: string) {
  if (typeof string !== 'string') throw new TypeError('Expected a string');

  // see https://github.com/sindresorhus/escape-string-regexp
  return string
    .replace(/[|\\{}()[\]^$+*?.]/g, '\\$&')
    .replace(/-/g, '\\x2d');
}


function markEdited(node: AstNode, edits: Array<Edit>): number | false {
  for (const [start, end] of edits) {
    if ((start <= node.start && node.start < end) || (start < node.end && node.end <= end)) {
      return false; // Already edited
    }
  }

  // Not edited
  return edits.push([node.start, node.end]);
}

export const SUPPORTED_FILES = ['js', 'ts', 'mjs', 'mts', 'cjs', 'cts', 'jsx', 'tsx', 'vue', 'svelte'];

// Vue's SFC compiler rewrites references to setup bindings when compiling
// templates. `{{ ENV.X }}` becomes `$setup.ENV.X` in dev (non-inline) render
// fns, and `_unref(ENV).X` in production (inline) mode, since an imported
// binding might be a ref. `_unref` on a plain object is a no-op, so replacing
// the whole call + member expression with the literal value is equivalent.
// Only the generated `_unref` alias is matched; a bare `unref(...)` call is
// user-authored code (possibly a different function entirely) and is left alone.
function getVueUnrefPattern(key: string): string | undefined {
  const dotIdx = key.indexOf('.');
  if (dotIdx === -1) return undefined;
  return `_unref(${key.slice(0, dotIdx)})${key.slice(dotIdx)}`;
}

type MatchersArray = Array<{ matcher: ReturnType<typeof astMatcher>, replacement: string }>;

export function createReplacerTransformFn(opts: {
  replacements: Record<string, string>,
}) {
  const keys = Object.keys(opts.replacements);
  let matchers: MatchersArray;
  const extraMatchersForFileType: Record<string, MatchersArray> = {};

  // quick-exit check, including the vue `_unref(OBJ).X` shape, which does not
  // contain the plain `OBJ.X` key as a substring
  const findAnyReplacementPatterns = keys.flatMap((key) => {
    const unrefPattern = getVueUnrefPattern(key);
    return unrefPattern ? [key, unrefPattern] : [key];
  });
  const findAnyReplacementRegex = new RegExp(`(?:${findAnyReplacementPatterns.map(escapeStringRegexp).join('|')})`, 'g');

  return function transform(
    parserCtx: {
      parse: AstParseFn;
    },
    code: string,
    id: string,
  ) {
    if (keys.length === 0) return null;

    const fileExt = id.split('?')[0].split('#')[0].split('.').pop() || '';
    if (!SUPPORTED_FILES.includes(fileExt)) return null;

    if (code.search(findAnyReplacementRegex) === -1) return null;

    const parse = (codeToParse: string, source = code): any => {
      try {
        return parserCtx.parse(codeToParse, undefined);
      } catch (error) {
        (error as Error).message += ` in ${source}`;
        throw error;
      }
    };

    const ast = parse(code, id);

    matchers ||= keys.map((key) => ({
      matcher: astMatcher(parse(key)),
      replacement: opts.replacements[key],
    }));

    if (fileExt === 'vue') {
      // in vue script+setup files, ENV.X in template blocks gets compiled to
      // `$setup.ENV.X` (dev) or `_unref(ENV).X` (prod inline mode); see
      // getVueUnrefPattern above
      extraMatchersForFileType.vue ||= keys.flatMap((key) => {
        const unrefPattern = getVueUnrefPattern(key);
        return [`$setup.${key}`, ...(unrefPattern ? [unrefPattern] : [])].map((pattern) => ({
          matcher: astMatcher(parse(pattern)),
          replacement: opts.replacements[key],
        }));
      });
    }

    const magicString = new MagicString(code);
    const edits: Array<Edit> = [];

    Object.values([...matchers, ...extraMatchersForFileType[fileExt] || []]).forEach(({ matcher, replacement }) => {
      for (const { node } of (matcher(ast) || []) as Array<{ node: AstNode }>) {
        if (markEdited(node, edits)) {
          magicString.overwrite(
            node.start,
            node.end,
            replacement,
          );
        }
      }
    });

    if (edits.length === 0) return null;

    // return the MagicString so the plugin can make further modifications
    return magicString;
  };
}
