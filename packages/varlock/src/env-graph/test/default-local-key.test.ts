import {
  describe, test, expect,
} from 'vitest';
import outdent from 'outdent';
import { EnvGraph, DotEnvFileDataSource } from '../index';

async function loadSchema(contents: string) {
  const g = new EnvGraph();
  await g.setRootDataSource(new DotEnvFileDataSource('.env.schema', { overrideContents: contents }));
  await g.finishLoad();
  return g;
}

function schemaErrors(g: EnvGraph) {
  return g.sortedDataSources.flatMap((s) => s.rootDecorators).flatMap((d) => d.errors);
}

describe('@defaultLocalKey root decorator', () => {
  test('defaults to varlock-default when not set', async () => {
    const g = await loadSchema(outdent`
      FOO=bar
    `);
    expect(g.defaultLocalKeyId).toBe('varlock-default');
  });

  test('reads a valid static key id', async () => {
    const g = await loadSchema(outdent`
      # @defaultLocalKey=ci
      # ---
      FOO=bar
    `);
    expect(g.defaultLocalKeyId).toBe('ci');
    expect(schemaErrors(g).filter((e) => !e.isWarning)).toHaveLength(0);
  });

  test('rejects an invalid key id', async () => {
    const g = await loadSchema(outdent`
      # @defaultLocalKey="bad key"
      # ---
      FOO=bar
    `);
    const errs = schemaErrors(g).filter((e) => !e.isWarning);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some((e) => /not a valid key id/.test(e.message))).toBe(true);
  });

  test('rejects a non-static value', async () => {
    const g = await loadSchema(outdent`
      # @defaultLocalKey=$SOME_REF
      # ---
      SOME_REF=ci
      FOO=bar
    `);
    const errs = schemaErrors(g).filter((e) => !e.isWarning);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some((e) => /static/.test(e.message))).toBe(true);
  });
});
