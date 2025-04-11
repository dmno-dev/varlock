// @ts-check
import tseslint from 'typescript-eslint';
import stylistic from '@stylistic/eslint-plugin';
import airbnb from 'eslint-stylistic-airbnb';
import globals from 'globals';
import nofixPlugin from 'eslint-nofix-plugin';

export default tseslint.config(
  {
    plugins: {
      '@stylistic': stylistic,
      '@nofix': nofixPlugin,
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
      'packages/eslint-custom-rules',
      'packages/env-spec/src/grammar.js',
      '**/.dmno/.typegen',
    ],
  },
  {

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
          argsIgnorePattern: '^_|^(response)$',
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
    files: [
      'scripts/**',
      'example-repo/**',
      'packages/*.ignore/**',
      'packages/varlock/src/cli/**',
      'packages/varlock/scripts/**',
    ],
    rules: {
      'no-console': 0,
    },
  },
);
