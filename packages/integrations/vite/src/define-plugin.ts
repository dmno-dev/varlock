/*
  This is adapted from https://www.npmjs.com/package/rollup-plugin-define

  Initially we were using @rollup/plugin-replace, but it would replace text in strings

  This instead replaces nodes in a parsed AST rather than text in a string.

  But we've simplified things slightly and removed some dependencies.
*/
import type {
  Plugin, PluginContext, TransformPluginContext, SourceDescription,
} from 'rollup';

import MagicString from 'magic-string';
import astMatcher from 'ast-matcher';

type Edit = [number, number];
type AstNode = { start: number; end: number };

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

const SUPPORTED_FILES = ['js', 'ts', 'mjs', 'mts', 'cjs', 'cts', 'jsx', 'tsx', 'vue', 'svelte'];

type MatchersArray = Array<{ matcher: ReturnType<typeof astMatcher>, replacement: string }>;

export function definePlugin(opts: {
  replacements: Record<string, string>,
}): Plugin {
  const keys = Object.keys(opts.replacements);
  let matchers: MatchersArray;
  const extraMatchersForFileType: Record<string, MatchersArray> = {};

  const findAnyReplacementRegex = new RegExp(`(?:${keys.map(escapeStringRegexp).join('|')})`, 'g');

  function transform(
    this: { parse: TransformPluginContext['parse']; warn: TransformPluginContext['warn'] },
    code: string,
    id: string,
  ): SourceDescription | null {
    if (keys.length === 0) return null;

    const fileExt = id.split('.').pop() || '';
    if (!SUPPORTED_FILES.includes(fileExt)) return null;

    if (code.search(findAnyReplacementRegex) === -1) return null;

    const parse = (codeToParse: string, source = code): ReturnType<PluginContext['parse']> => {
      try {
        return this.parse(codeToParse, undefined);
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
      // in vue script+setup files, ENV.X in template blocks gets replaced with `$setup.ENV.X`
      extraMatchersForFileType.vue ||= keys.map((key) => ({
        matcher: astMatcher(parse(`$setup.${key}`)),
        replacement: opts.replacements[key],
      }));
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

    if (edits.length === 0) {
      // console.log(code);
      return null;
    }

    return {
      code: magicString.toString(),
      map: magicString.generateMap({ source: code, includeContent: true, hires: true }),
    };
  }

  return {
    name: 'define',
    transform,
    renderChunk(code, chunk) {
      return transform.call(this, code, chunk.fileName);
    },
  };
}
