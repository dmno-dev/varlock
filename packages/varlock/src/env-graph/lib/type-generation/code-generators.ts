import type { EnvGraph } from '../env-graph';
import type { TypeGenItemInfo } from '../config-item';
import { isVarlockReservedKey } from '../reserved-vars';
import { generateGoEnvSrc, resolveGoPackageName } from './emitters/go';
import { generatePhpEnvSrc } from './emitters/php';
import { generatePythonEnvSrc } from './emitters/python';
import { generateRustEnvSrc } from './emitters/rust';
import { generateTsTypesSrc } from './emitters/ts';
import { type ResolvedFieldType } from './shared';

/** Everything a code generator needs to produce a single output file. */
export type CodeGenContext = {
  graph: EnvGraph;
  /** language-agnostic resolved field types — the common input every generator consumes */
  fields: Array<ResolvedFieldType>;
  /** resolved decorator args (e.g. `env`, `processEnv`, `lang`) */
  options: Record<string, any>;
  /** absolute path the output should be written to */
  outputPath: string;
  /** directory of the source file that declared the decorator */
  sourceDir: string;
};

/**
 * A code generator is contributed by a root decorator. Built-in generators are registered through
 * the same `graph.registerCodeGenerator()` API that plugins use, so plugins can add their own.
 */
export type CodeGeneratorDef = {
  /** root decorator name that triggers this generator, e.g. `generateTsTypes` */
  decoratorName: string;
  /**
   * option (named-arg) names this generator accepts, beyond the shared `path`/`auto`/
   * `executeWhenImported`. When set, unknown option names on the decorator are a schema error —
   * catching typos like `exposEnv=` that would otherwise be silently ignored. Omit to accept
   * anything (the deprecated `@generateTypes` alias does this for back-compat).
   */
  knownOptions?: Array<string>;
  /** produce the file contents for one decorator instance */
  generate: (ctx: CodeGenContext) => string | Promise<string>;
};

/** Collect the items that belong in generated output — schema-only, non-env-specific. */
export async function collectTypeGenItems(graph: EnvGraph): Promise<Array<TypeGenItemInfo>> {
  const items: Array<TypeGenItemInfo> = [];
  for (const itemKey of graph.sortedConfigKeys) {
    // _VARLOCK_* keys are varlock infrastructure — not accessed via the ENV proxy
    if (isVarlockReservedKey(itemKey)) continue;
    const configItem = graph.configSchema[itemKey];
    if (!configItem.defsForTypeGeneration.length) continue;
    // @internal items are not injected into the app, so they shouldn't appear in the typed ENV
    if (configItem.isInternal) continue;
    items.push(await configItem.getTypeGenInfo());
  }
  return items;
}

// language code -> per-language decorator, used to point users off the deprecated `@generateTypes(lang=...)`
const LANG_TO_DECORATOR: Record<string, string> = {
  py: 'generatePythonEnv',
  rs: 'generateRustEnv',
  go: 'generateGoEnv',
  php: 'generatePhpEnv',
};

function generateTsFile(ctx: CodeGenContext): Promise<string> {
  // local mode emits a runtime re-export (TypeScript syntax) — a `.d.ts` has no runtime binding,
  // and anything else (`.js`, ...) would not parse, so require a real `.ts` module
  if (ctx.options.exposeEnv === 'local'
    && (!ctx.outputPath.endsWith('.ts') || ctx.outputPath.endsWith('.d.ts'))) {
    throw new Error(
      '@generateTsTypes - `exposeEnv=local` emits a runtime re-export, so it needs a `.ts` output path (not `.d.ts`).',
    );
  }

  const options = { ...ctx.options };
  // when `@disableProcessEnvInjection` is set, varlock doesn't populate process.env, so don't
  // type it as populated. This only sets the default — an explicit `processEnv=` still wins.
  if (options.processEnv === undefined && ctx.graph.isProcessEnvInjectionDisabled) {
    options.processEnv = 'none';
  }

  return generateTsTypesSrc(ctx.fields, options);
}

export const builtInCodeGenerators: Array<CodeGeneratorDef> = [
  {
    decoratorName: 'generateTsTypes',
    knownOptions: ['exposeEnv', 'processEnv', 'importMetaEnv'],
    generate: generateTsFile,
  },
  { decoratorName: 'generatePythonEnv', knownOptions: [], generate: (ctx) => generatePythonEnvSrc(ctx.fields) },
  { decoratorName: 'generateRustEnv', knownOptions: [], generate: (ctx) => generateRustEnvSrc(ctx.fields) },
  {
    decoratorName: 'generateGoEnv',
    knownOptions: ['package'],
    generate: (ctx) => generateGoEnvSrc(ctx.fields, {
      packageName: resolveGoPackageName(ctx.outputPath, ctx.options.package),
    }),
  },
  {
    decoratorName: 'generatePhpEnv',
    knownOptions: ['namespace', 'class'],
    generate: (ctx) => generatePhpEnvSrc(ctx.fields, {
      namespace: ctx.options.namespace,
      className: ctx.options.class,
    }),
  },
  {
    // deprecated ts-only alias — kept for back-compat with existing schemas that still use it.
    // no knownOptions: it historically ignored unknown args, so stay lenient
    decoratorName: 'generateTypes',
    generate: (ctx) => {
      const { lang } = ctx.options;
      // `lang` was always required — a missing one must not silently fall through to TypeScript
      // output (which would overwrite e.g. an `env.py` path with TS declarations)
      if (!lang) {
        throw new Error('@generateTypes - must set `lang` arg (or use @generateTsTypes(path=...))');
      }
      if (lang !== 'ts') {
        const suggestion = LANG_TO_DECORATOR[lang];
        throw new Error(
          `@generateTypes only supports \`lang=ts\`.${suggestion ? ` For \`${lang}\`, use @${suggestion}(path=...).` : ''}`,
        );
      }
      return generateTsFile(ctx);
    },
  },
];
