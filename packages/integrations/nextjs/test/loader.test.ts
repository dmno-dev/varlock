import { parse as babelParse } from '@babel/parser';
import {
  describe, it, expect, beforeEach, vi,
} from 'vitest';
// the loader only has a CJS `module.exports =` export (required by webpack's
// loader-runner) — vitest surfaces it as the namespace default
import * as loaderModule from '../src/loader';

type LoaderOptions = { bundler?: 'webpack' | 'turbopack'; isEdge?: boolean; dev?: boolean };
type LoaderContext = {
  cacheable(flag: boolean): void;
  resourcePath: string;
  rootContext: string;
  getOptions(): LoaderOptions;
};
const loader = (loaderModule as any).default as (this: LoaderContext, source: string) => string;

const PROJECT_ROOT = '/proj';

function runLoader(source: string, opts?: {
  resourcePath?: string;
  options?: LoaderOptions;
}) {
  const ctx: LoaderContext = {
    cacheable: () => undefined,
    resourcePath: opts?.resourcePath ?? `${PROJECT_ROOT}/app/page.tsx`,
    rootContext: PROJECT_ROOT,
    getOptions: () => opts?.options ?? { bundler: 'turbopack' as const, dev: false },
  };
  return loader.call(ctx, source);
}

function setEnvGraph(config: Record<string, { value: any, isSensitive: boolean }>) {
  process.env.__VARLOCK_ENV = JSON.stringify({
    config,
    settings: {},
    sources: [],
  });
}

beforeEach(() => {
  setEnvGraph({
    PUBLIC_VAR: { value: 'public-value', isSensitive: false },
    OTHER_VAR: { value: 123, isSensitive: false },
    UNDEF_VAR: { value: undefined, isSensitive: false },
    SECRET_VAR: { value: 'shh', isSensitive: true },
  });
});

// all sources are marked as client components so results are not
// cluttered with the injected server init guard
const USE_CLIENT = "'use client';\n";

describe('static ENV.x replacement (turbopack)', () => {
  it('replaces legitimate member expressions', () => {
    const result = runLoader(USE_CLIENT + [
      'const a = ENV.PUBLIC_VAR;',
      'fn(ENV.PUBLIC_VAR, ENV.OTHER_VAR);',
      'if (ENV.PUBLIC_VAR) {}',
      'const el = <div title={ENV.PUBLIC_VAR} />;',
    ].join('\n'));
    expect(result).toContain('const a = "public-value";');
    expect(result).toContain('fn("public-value", 123);');
    expect(result).toContain('if ("public-value") {}');
    expect(result).toContain('<div title={"public-value"} />');
  });

  it('does NOT replace matches inside string literals', () => {
    const source = USE_CLIENT + [
      'console.log("ENV.PUBLIC_VAR is set");',
      "const s = 'text ENV.PUBLIC_VAR more';",
    ].join('\n');
    const result = runLoader(source);
    expect(result).toContain('console.log("ENV.PUBLIC_VAR is set");');
    expect(result).toContain("const s = 'text ENV.PUBLIC_VAR more';");
  });

  it('does NOT replace matches inside comments', () => {
    const source = USE_CLIENT + [
      'const a = ENV.PUBLIC_VAR; // uses ENV.PUBLIC_VAR here',
      '/* block comment mentioning ENV.PUBLIC_VAR */',
      'const b = 1;',
    ].join('\n');
    const result = runLoader(source);
    expect(result).toContain('const a = "public-value"; // uses ENV.PUBLIC_VAR here');
    expect(result).toContain('/* block comment mentioning ENV.PUBLIC_VAR */');
  });

  it('replaces interpolations but not text in template literals', () => {
    const source = `${USE_CLIENT}const t = \`text ENV.PUBLIC_VAR and \${ENV.PUBLIC_VAR}\`;`;
    const result = runLoader(source);
    // eslint-disable-next-line no-template-curly-in-string
    expect(result).toContain('`text ENV.PUBLIC_VAR and ${"public-value"}`');
  });

  it('does NOT replace ENV.KEY as part of a longer identifier', () => {
    const source = USE_CLIENT + [
      'const a = ENV.PUBLIC_VAR_LONGER;',
      'const b = MY_ENV.PUBLIC_VAR;',
      'const c = ENVX.PUBLIC_VAR;',
    ].join('\n');
    const result = runLoader(source);
    expect(result).toContain('const a = ENV.PUBLIC_VAR_LONGER;');
    expect(result).toContain('const b = MY_ENV.PUBLIC_VAR;');
    expect(result).toContain('const c = ENVX.PUBLIC_VAR;');
  });

  it('does NOT replace matches inside JSX text', () => {
    const source = `${USE_CLIENT}const el = <p>ENV.PUBLIC_VAR as jsx text: {ENV.PUBLIC_VAR}</p>;`;
    const result = runLoader(source);
    expect(result).toContain('<p>ENV.PUBLIC_VAR as jsx text: {"public-value"}</p>');
  });

  it('does NOT replace nested member expressions like foo.ENV.KEY', () => {
    const source = `${USE_CLIENT}const a = someObj.ENV.PUBLIC_VAR;`;
    expect(runLoader(source)).toContain('const a = someObj.ENV.PUBLIC_VAR;');
  });

  it('never inlines sensitive values', () => {
    const source = `${USE_CLIENT}const a = ENV.SECRET_VAR;`;
    const result = runLoader(source);
    expect(result).toContain('const a = ENV.SECRET_VAR;');
    expect(result).not.toContain('shh');
  });

  it('inlines undefined values as a literal', () => {
    const source = `${USE_CLIENT}const a = ENV.UNDEF_VAR;`;
    expect(runLoader(source)).toContain('const a = undefined;');
  });

  it('handles typescript syntax (types, satisfies, casts)', () => {
    const source = USE_CLIENT + [
      'const a: string = ENV.PUBLIC_VAR as string;',
      'type Foo = { key: typeof ENV.PUBLIC_VAR };',
    ].join('\n');
    const result = runLoader(source, { resourcePath: `${PROJECT_ROOT}/lib/thing.ts` });
    expect(result).toContain('const a: string = "public-value" as string;');
  });

  it('falls back to regex replacement when the file cannot be parsed', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      // unclosed brace makes this unparseable even with errorRecovery
      const source = `${USE_CLIENT}function broken( { const a = ENV.PUBLIC_VAR;`;
      const result = runLoader(source);
      expect(result).toContain('const a = "public-value";');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('falling back to regex replacement'),
        expect.anything(),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('directive prologue handling', () => {
  const SOURCE_BODY = 'export function fn() { return 1; }';
  // a server file so the init guard gets injected — that is what has to land
  // after the directives rather than in the middle of them
  const runServerLoader = (source: string) => runLoader(source, {
    resourcePath: `${PROJECT_ROOT}/app/thing.ts`,
    options: { bundler: 'turbopack', dev: false },
  });

  /** directives babel still recognizes as directives in the loader output */
  function directivesOf(code: string) {
    const ast = babelParse(code, { sourceType: 'unambiguous', plugins: ['typescript'] });
    return ast.program.directives.map((d) => d.value.value);
  }

  it.each([
    ['use server'],
    ['use strict'],
    ['use cache'],
    ['use cache: remote'],
    ['use cache: private'],
    ['use workflow'],
    ['use memo'],
    ['use no memo'],
    // no allowlist — directives that do not exist yet must survive too
    ['use some-future-directive'],
  ])('preserves \'%s\' and injects after it', (directive) => {
    const result = runServerLoader(`'${directive}';\n${SOURCE_BODY}`);
    expect(directivesOf(result)).toContain(directive);
    expect(result).toContain('globalThis.__varlockBuildInit');
  });

  // client components get no init guard, so only the directive itself is checked
  it('preserves \'use client\'', () => {
    const result = runServerLoader(`'use client';\n${SOURCE_BODY}`);
    expect(directivesOf(result)).toEqual(['use client']);
  });

  it('preserves stacked directives (never injects between them)', () => {
    const result = runServerLoader(`'use strict';\n'use server';\n'use cache';\n${SOURCE_BODY}`);
    expect(directivesOf(result)).toEqual(['use strict', 'use server', 'use cache']);
  });

  it('handles directives without trailing semicolons and with double quotes', () => {
    const result = runServerLoader(`"use server"\n'use cache'\n${SOURCE_BODY}`);
    expect(directivesOf(result)).toEqual(['use server', 'use cache']);
  });

  it('handles comments and blank lines around directives', () => {
    const result = runServerLoader([
      '// leading line comment',
      '',
      '/* block',
      '   comment */',
      "'use server';",
      '// between directives',
      '',
      "'use cache';",
      '',
      SOURCE_BODY,
    ].join('\n'));
    expect(directivesOf(result)).toEqual(['use server', 'use cache']);
  });

  it('handles a file that is only a directive', () => {
    const result = runServerLoader("'use server'");
    expect(directivesOf(result)).toEqual(['use server']);
  });

  it('injects at the top when there is no directive', () => {
    const result = runServerLoader(SOURCE_BODY);
    expect(result.startsWith('if(!globalThis.__varlockBuildInit)')).toBe(true);
  });

  it('does not treat a leading string that continues an expression as a directive', () => {
    // `'use x' + y` is one expression statement — injecting inside it would be a syntax error
    const result = runServerLoader(`'use x' + globalThis.y;\n${SOURCE_BODY}`);
    expect(() => directivesOf(result)).not.toThrow();
    expect(result).toContain("'use x' + globalThis.y;");
  });
});

describe('inlining gate (dev vs build, client vs server vs edge)', () => {
  const SERVER_SOURCE = 'const a = ENV.PUBLIC_VAR;';

  it('does NOT inline into server files in dev (runtime proxy reads stay fresh)', () => {
    const result = runLoader(SERVER_SOURCE, { options: { bundler: 'turbopack', dev: true } });
    expect(result).toContain('const a = ENV.PUBLIC_VAR;');
  });

  it('inlines into server files during builds', () => {
    const result = runLoader(SERVER_SOURCE, { options: { bundler: 'turbopack', dev: false } });
    expect(result).toContain('const a = "public-value";');
  });

  it('inlines into client components in dev', () => {
    const result = runLoader(USE_CLIENT + SERVER_SOURCE, { options: { bundler: 'turbopack', dev: true } });
    expect(result).toContain('const a = "public-value";');
  });

  it('inlines into middleware files in dev (edge sniff by path)', () => {
    const result = runLoader(SERVER_SOURCE, {
      resourcePath: `${PROJECT_ROOT}/middleware.ts`,
      options: { bundler: 'turbopack', dev: true },
    });
    expect(result).toContain('const a = "public-value";');
  });

  it('inlines into edge runtime files in dev (edge sniff by source)', () => {
    const source = `export const runtime = 'edge';\n${SERVER_SOURCE}`;
    const result = runLoader(source, { options: { bundler: 'turbopack', dev: true } });
    expect(result).toContain('const a = "public-value";');
  });

  it('still injects the init guard into server files', () => {
    const result = runLoader(SERVER_SOURCE, { options: { bundler: 'turbopack', dev: false } });
    expect(result).toContain('globalThis.__varlockBuildInit');
  });

  it('does not inject the init guard into client components', () => {
    const result = runLoader(USE_CLIENT + SERVER_SOURCE);
    expect(result).not.toContain('globalThis.__varlockBuildInit');
  });
});
