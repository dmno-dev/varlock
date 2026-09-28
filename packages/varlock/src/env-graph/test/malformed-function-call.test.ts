import { describe, test, expect } from 'vitest';
import outdent from 'outdent';
import { EnvGraph } from '../index';
import { DotEnvFileDataSource } from '../lib/data-source';

async function loadSchema(contents: string) {
  const g = new EnvGraph();
  await g.setRootDataSource(new DotEnvFileDataSource('.env.schema', { overrideContents: contents }));
  await g.finishLoad();
  await g.resolveEnvValues();
  return g;
}

function schemaErrorMessages(g: EnvGraph, key: string) {
  return g.configSchema[key].errors.filter((e) => !e.isWarning).map((e) => e.message);
}

describe('malformed function calls', () => {
  test('unquoted fn arg with a space errors instead of becoming a string', async () => {
    const g = await loadSchema(outdent`
      UNQUOTED_SPACE=concat(foo bar, -baz)
      NESTED=concat(a, concat(b c, d))
      TRAILING_COMMENT=concat(foo bar, -baz) # comment
    `);
    for (const key of ['UNQUOTED_SPACE', 'NESTED', 'TRAILING_COMMENT']) {
      expect(schemaErrorMessages(g, key)).toEqual(['Value looks like a call to concat() but could not be parsed as a function call']);
      expect(g.configSchema[key].resolvedValue).toBeUndefined();
    }
  });

  test('valid and quoted values are unaffected', async () => {
    const g = await loadSchema(outdent`
      QUOTED_ARG=concat("foo bar", -baz)
      QUOTED_WHOLE="concat(foo bar, -baz)"
      NOT_A_CALL=hello (world)
      PAREN_MID=a fn(b c)
    `);
    expect(g.configSchema.QUOTED_ARG.resolvedValue).toBe('foo bar-baz');
    expect(g.configSchema.QUOTED_WHOLE.resolvedValue).toBe('concat(foo bar, -baz)');
    expect(g.configSchema.NOT_A_CALL.resolvedValue).toBe('hello (world)');
    expect(g.configSchema.PAREN_MID.resolvedValue).toBe('a fn(b c)');
    for (const key of ['QUOTED_ARG', 'QUOTED_WHOLE', 'NOT_A_CALL', 'PAREN_MID']) {
      expect(schemaErrorMessages(g, key)).toEqual([]);
    }
  });

  test('unquoted decorator fn arg with a space errors', async () => {
    const g = await loadSchema(outdent`
      # @sensitive=forEnv(prod staging)
      ITEM=foo
    `);
    expect(schemaErrorMessages(g, 'ITEM')).toEqual(['@sensitive value looks like a call to forEnv() but could not be parsed as a function call']);
  });
});
