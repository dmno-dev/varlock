import { describe, test, expect } from 'vitest';
import outdent from 'outdent';
import type { EnvGraph } from '../index';
import { loadGraph } from './type-generation/helpers';

async function load(files: Record<string, string>, opts?: { fallbackEnv?: string }) {
  const g = await loadGraph({ files, ...opts });
  await g.resolveEnvValues();
  return g;
}

/** the "can never match" findings, from every item and every data source */
function forEnvFindings(g: EnvGraph) {
  return [
    ...Object.values(g.configSchema).flatMap((item) => item.errors),
    ...g.sortedDataSources.flatMap((source) => source.errors),
  ].filter((e) => e.message.includes('can never match'));
}

const ENV_ITEM = outdent`
  # @currentEnv=$APP_ENV
  # ---
  # @type=enum(development, production)
  # @public
  APP_ENV=production
`;

describe('forEnv() args that are not a value of the @currentEnv enum', () => {
  test('a typo in @required=forEnv() warns with a did-you-mean hint', async () => {
    const g = await load({
      '.env.schema': `${ENV_ITEM}\n# @required=forEnv(prodution) @type=url\nAPI_URL=\n`,
    });
    const [finding, ...rest] = forEnvFindings(g);
    expect(rest).toEqual([]);
    expect(finding.isWarning).toBe(true);
    expect(finding.message).toBe(
      'forEnv(): "prodution" is not a possible value of APP_ENV (the @currentEnv item: development, production), so it can never match. Did you mean "production"?',
    );
    expect(g.configSchema.API_URL.validationState).toBe('warn');
  });

  test('it stays a warning: the schema still loads and resolves', async () => {
    const g = await load({
      '.env.schema': `${ENV_ITEM}\n# @required=forEnv(prodution)\nAPI_KEY=abc\n`,
    });
    expect(forEnvFindings(g)).toHaveLength(1);
    expect(g.configSchema.API_KEY.isValid).toBe(true);
    expect(g.configSchema.API_KEY.resolvedValue).toBe('abc');
  });

  test('correct spelling does not warn', async () => {
    const g = await load({
      '.env.schema': `${ENV_ITEM}\n# @required=forEnv(production) @type=url\nAPI_URL=https://example.com\n`,
    });
    expect(forEnvFindings(g)).toEqual([]);
    expect(g.configSchema.API_URL.validationState).toBe('valid');
  });

  test('only the bad arg of several is reported', async () => {
    const g = await load({
      '.env.schema': `${ENV_ITEM}\n# @required=forEnv(development, prodution, production)\nAPI_KEY=abc\n`,
    });
    const findings = forEnvFindings(g);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain('"prodution"');
  });

  test('a case difference gets a hint', async () => {
    const g = await load({
      '.env.schema': `${ENV_ITEM}\n# @required=forEnv(Production)\nAPI_KEY=abc\n`,
    });
    expect(forEnvFindings(g)[0].message).toContain('Did you mean "production"?');
  });

  test('with nothing close, it only lists the possible values', async () => {
    const g = await load({
      '.env.schema': `${ENV_ITEM}\n# @required=forEnv(staging)\nAPI_KEY=abc\n`,
    });
    const [finding] = forEnvFindings(g);
    expect(finding.message).toContain('(the @currentEnv item: development, production)');
    expect(finding.message).not.toContain('Did you mean');
  });

  test('checks forEnv() used as an item value', async () => {
    const g = await load({
      '.env.schema': `${ENV_ITEM}\nLOG_LEVEL=if(forEnv(prodution), warn, debug)\n`,
    });
    expect(forEnvFindings(g)).toHaveLength(1);
  });

  test('checks forEnv() in a root decorator', async () => {
    const g = await load({
      '.env.schema': outdent`
        # @currentEnv=$APP_ENV
        # @import(./.env.extra, enabled=forEnv(prodution))
        # ---
        # @type=enum(development, production)
        # @public
        APP_ENV=production
      `,
      '.env.extra': 'EXTRA=1\n',
    });
    const findings = forEnvFindings(g);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain('Did you mean "production"?');
  });

  describe('an imported file with its own @currentEnv', () => {
    // @disable runs before the file's own @currentEnv applies, so it evaluates against the
    // parent's env item; everything else in the file uses the file's own
    const parent = outdent`
      # @currentEnv=$APP_ENV
      # @import(./.env.child)
      # ---
      # @type=enum(development, production)
      # @public
      APP_ENV=production
    `;
    const childHeader = (disable: string) => outdent`
      # @disable=${disable}
      # @currentEnv=$CHILD_ENV
      # ---
      # @type=enum(staging, release)
      # @public
      CHILD_ENV=staging
    `;

    test('@disable is checked against the parent env, not the file\'s own', async () => {
      const g = await load({
        '.env.schema': parent,
        '.env.child': `${childHeader('forEnv(development)')}\n`,
      });
      expect(forEnvFindings(g)).toEqual([]);

      const typo = await load({
        '.env.schema': parent,
        '.env.child': `${childHeader('forEnv(prodution)')}\n`,
      });
      const findings = forEnvFindings(typo);
      expect(findings).toHaveLength(1);
      expect(findings[0].message).toContain('possible value of APP_ENV');
    });

    test('@import(enabled=) in the file is checked against the file\'s own env item', async () => {
      const g = await load({
        '.env.schema': parent,
        '.env.child': outdent`
          # @currentEnv=$CHILD_ENV
          # @import(./.env.grandchild, enabled=forEnv(production))
          # ---
          # @type=enum(staging, release)
          # @public
          CHILD_ENV=staging
        `,
        '.env.grandchild': 'GRANDCHILD=1\n',
      });
      const findings = forEnvFindings(g);
      expect(findings).toHaveLength(1);
      expect(findings[0].message).toContain('"production" is not a possible value of CHILD_ENV');
    });

    test('items in the file are checked against the file\'s own env item', async () => {
      const g = await load({
        '.env.schema': parent,
        '.env.child': `${childHeader('false')}\n# @required=forEnv(staging, development)\nKEY=abc\n`,
      });
      const findings = forEnvFindings(g);
      expect(findings).toHaveLength(1);
      expect(findings[0].message).toContain('"development" is not a possible value of CHILD_ENV');
    });
  });

  test('numeric enum members compare by their string form', async () => {
    const g = await load({
      '.env.schema': outdent`
        # @currentEnv=$STAGE
        # ---
        # @type=enum(1, 2)
        # @public
        STAGE=1
        # @required=forEnv(2, 3)
        API_KEY=abc
      `,
    });
    const findings = forEnvFindings(g);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain('"3"');
  });

  describe('left alone', () => {
    test('dynamic args', async () => {
      const g = await load({
        '.env.schema': `${ENV_ITEM}\n# @required=forEnv($APP_ENV)\nAPI_KEY=abc\n`,
      });
      expect(forEnvFindings(g)).toEqual([]);
    });

    test('a @currentEnv item that is not an enum', async () => {
      const g = await load({
        '.env.schema': outdent`
          # @currentEnv=$APP_ENV
          # ---
          # @public
          APP_ENV=production
          # @required=forEnv(prodution)
          API_KEY=abc
        `,
      });
      expect(forEnvFindings(g)).toEqual([]);
    });

    test('an enum whose members are computed', async () => {
      const g = await load({
        '.env.schema': outdent`
          # @currentEnv=$APP_ENV
          # ---
          # @type=enum(development, $EXTRA_ENV)
          # @public
          APP_ENV=production
          EXTRA_ENV=production
          # @required=forEnv(prodution)
          API_KEY=abc
        `,
      });
      // control: the type really is computed, so the skip is the computed-type guard
      expect(g.configSchema.APP_ENV.hasComputedType).toBe(true);
      expect(forEnvFindings(g)).toEqual([]);
    });

    test('no @currentEnv item (a graph-level fallback env is not checked)', async () => {
      const g = await load({
        '.env.schema': '# @required=forEnv(prodution)\nAPI_KEY=abc\n',
      }, { fallbackEnv: 'production' });
      expect(forEnvFindings(g)).toEqual([]);
    });
  });
});
