// @ts-check
import tseslint from 'typescript-eslint';
import stylistic from '@stylistic/eslint-plugin';
import airbnb from 'eslint-stylistic-airbnb';
import globals from 'globals';
import nofixPlugin from 'eslint-plugin-fix-disabled-rules';
import eslintPluginJsonc from 'eslint-plugin-jsonc';
import pluginESx from 'eslint-plugin-es-x';
import pluginN from 'eslint-plugin-n';

// fix renamed rule
if (airbnb.rules['@stylistic/func-call-spacing']) {
  airbnb.rules['@stylistic/function-call-spacing'] = airbnb.rules['@stylistic/func-call-spacing'];
  // @ts-ignore
  delete airbnb.rules['@stylistic/func-call-spacing'];
}


export default tseslint.config(
  {
    plugins: {
      '@stylistic': stylistic,
      '@nofix': nofixPlugin,
      'es-x': pluginESx,
      n: pluginN,
    },
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },

  // @ts-ignore
  airbnb,
  ...tseslint.configs.recommended,

  {
    ignores: [
      '**/dist',
      '**/dist-sea',
      '**/node_modules',
      '**/.pnpm-store',
      '**/.turbo',
      'packages/eslint-custom-rules',
      'packages/env-spec-parser/src/grammar.js',
      'packages/varlock-website/.astro',
      '**/.dmno/.typegen',
      '**/*.ignore',
      '**/.vercel',
      '**/.netlify',
      '**/.astro',

    ],
  },

  {
    files: ['**/*.{js,mjs,cjs,ts,mts,cts}'],
    // NOTE - run `pnpm dlx @eslint/config-inspector@latest`
    // to help audit these rules
    rules: {
      // some preset rules to relax -----------
      '@typescript-eslint/ban-ts-comment': 0,
      '@typescript-eslint/no-explicit-any': 0,
      'no-plusplus': 0,
      radix: 0,
      'no-return-await': 0,
      'prefer-destructuring': 0,
      'no-else-return': 0, // sometimes clearer even though unnecessary
      'prefer-arrow-callback': 0,
      'arrow-body-style': 0,
      '@stylistic/lines-between-class-members': 0, // often nice to group related one-liners
      'max-classes-per-file': 0, // can make sense to colocate small classes
      'consistent-return': 0, // often can make sense to return (undefined) early
      'no-useless-return': 0, // sometimes helps clarify you are bailing early
      'no-continue': 0,
      'no-underscore-dangle': 0,
      'no-await-in-loop': 0,
      'no-lonely-if': 0,
      '@stylistic/no-multiple-empty-lines': 0,
      '@typescript-eslint/no-empty-object-type': 0,
      'class-methods-use-this': 0,
      'no-empty-function': 0, // typescript version is enabled

      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          caughtErrors: 'none',
          argsIgnorePattern: '^_|^(response|ctx)$',
          varsIgnorePattern: '^_|^(props|emit)$',
        },
      ],

      '@typescript-eslint/return-await': 0,
      '@typescript-eslint/array-type': ['error', { default: 'generic' }],


      '@stylistic/array-bracket-newline': ['error', { multiline: true }],
      '@stylistic/array-element-newline': ['error', 'consistent'],

      // other -----------------------------------------------------
      curly: ['error', 'multi-line'],
      '@stylistic/brace-style': 'error',
      '@stylistic/max-len': [
        'error',
        120,
        2,
        {
        // bumped to 120, otherwise same as airbnb's rule but ignoring comments
          ignoreUrls: true,
          ignoreComments: true,
          ignoreRegExpLiterals: true,
          ignoreStrings: true,
          ignoreTemplateLiterals: true,
        },
      ],
      '@stylistic/max-statements-per-line': ['error', { max: 1 }],

      // rules to disable for now, but will likely be turned back on --------
      // TODO: review these rules, infractions case by case, probably turn back on?
      '@typescript-eslint/no-use-before-define': 0,
      'no-param-reassign': 0,
      'no-restricted-syntax': 0,
      '@typescript-eslint/naming-convention': 0,
      '@typescript-eslint/no-shadow': 0,
      'guard-for-in': 0,

      // some rules to downgrade to warning which we'll allow while developing --------------------
      'no-console': 'warn',

      '@typescript-eslint/no-empty-function': 'warn',
      'no-debugger': 'warn',
      'no-alert': 'warn',
      'no-empty': 'warn',

      // rules that we want to warn, but disable agressive auto-fixing ----------------------------
      // commenting out var modifications in later code means auto changing let to const, and then getting angry when uncommenting
      'prefer-const': 0,
      '@nofix/prefer-const': 'warn',
    },
  },
  {
    files: ['packages/varlock/src/**'],
    rules: {
      // top level await not allowed in CJS build needed for bundled SEA
      'es-x/no-top-level-await': 'error',
    },
  },
  {
    files: ['packages/varlock/src/cli/**'],
    rules: {
      // use `gracefulExit` instead of process.exit in the CLI
      'n/no-process-exit': 'error',
    },
  },
  {
    files: [
      'scripts/**',
      'example-monorepo/**',
      'packages/*.ignore/**',
      'packages/varlock/src/cli/**',
      'packages/varlock/scripts/**',
    ],
    rules: {
      'no-console': 0,
    },
  },

  // set up lint rules for json files
  // note - the simpler methods were not working properly, so we list the rules here instead
  {
    files: ['**/*.json'],
    plugins: { jsonc: eslintPluginJsonc },
    languageOptions: { parser: eslintPluginJsonc },
    rules: {
      // generic rules
      '@stylistic/max-len': 0,
      // json rules
      'jsonc/no-bigint-literals': 'error',
      'jsonc/no-binary-expression': 'error',
      'jsonc/no-escape-sequence-in-identifier': 'error',
      'jsonc/no-number-props': 'error',
      'jsonc/no-parenthesized': 'error',
      'jsonc/no-regexp-literals': 'error',
      'jsonc/no-template-literals': 'error',
      'jsonc/no-undefined-value': 'error',
      'jsonc/no-unicode-codepoint-escapes': 'error',
      'jsonc/valid-json-number': 'error', // enables/replaces many more specific rules
      'jsonc/vue-custom-block/no-parsing-error': 'error',
      'jsonc/array-bracket-newline': ['error', { multiline: true, minItems: null }],
      'jsonc/array-bracket-spacing': ['error', 'never'],
      'jsonc/comma-style': ['error', 'last'],
      'jsonc/indent': ['error', 2, {}],
      'jsonc/key-spacing': ['error', { beforeColon: false, afterColon: true, mode: 'strict' }],
      'jsonc/no-dupe-keys': 'error',
      'jsonc/no-irregular-whitespace': 'error',
      'jsonc/no-multi-str': 'error',
      'jsonc/no-octal-escape': 'error',
      'jsonc/no-sparse-arrays': 'error',
      'jsonc/no-useless-escape': 'error',
      'jsonc/object-curly-newline': ['error', { consistent: true }],
      'jsonc/object-curly-spacing': ['error', 'always'],
      'jsonc/object-property-newline': 'error',
      'jsonc/quote-props': ['error', 'always', {}],
      'jsonc/quotes': ['error', 'double', { avoidEscape: false }],
      // rules to enable below for jsonc
      'jsonc/comma-dangle': ['error', 'never'],
      'jsonc/no-comments': 'error',
    },
  },

  { // JSONC
    files: ['**/tsconfig.json', '**/tsconfig.*.json', '**/.vscode/*.json', 'turbo.json'],
    rules: {
      'jsonc/comma-dangle': ['error', 'only-multiline'],
      'jsonc/no-comments': 0,
    },


  },
);
