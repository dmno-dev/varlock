import { describe, it, expect } from 'vitest';
import outdent from 'outdent';
import { EnvGraph } from '../index';
import { DotEnvFileDataSource } from '../lib/data-source';

async function loadSchema(contents: string, overrideValues?: Record<string, string>) {
  const g = new EnvGraph();
  await g.setRootDataSource(new DotEnvFileDataSource('.env.schema', { overrideContents: contents }));
  await g.finishLoad();
  if (overrideValues) g.overrideValues = overrideValues;
  await g.resolveEnvValues();
  return g;
}

describe('getSerializedGraph overrideStr', () => {
  it('records the raw override string when coercion changed its injected form', async () => {
    const g = await loadSchema(outdent`
      # @type=boolean @public
      FLAG=false
    `, { FLAG: 'YES' });
    const blob = g.getSerializedGraph();
    expect(blob.config.FLAG.value).toBe(true);
    expect(blob.config.FLAG.overrideStr).toBe('YES');
  });

  it('omits overrideStr when the raw override already matches the injected form', async () => {
    const g = await loadSchema(outdent`
      PLAIN=abc  # @public
    `, { PLAIN: 'from-env' });
    const blob = g.getSerializedGraph();
    expect(blob.config.PLAIN.value).toBe('from-env');
    expect(blob.config.PLAIN.overrideStr).toBeUndefined();
  });

  it('omits overrideStr for items that were not overridden', async () => {
    const g = await loadSchema(outdent`
      # @type=boolean @public
      FLAG=yes
    `);
    const blob = g.getSerializedGraph();
    expect(blob.config.FLAG.value).toBe(true);
    expect(blob.config.FLAG.overrideStr).toBeUndefined();
  });

  it('omits overrideStr for sensitive items even when coercion changed the form', async () => {
    // a boolean would be demoted to non-sensitive, so coerce a string instead
    const g = await loadSchema(outdent`
      # @type=string(toLowerCase=true) @sensitive
      SECRET_TOKEN=sk-live-placeholder
    `, { SECRET_TOKEN: 'SK-LIVE-9F2B71C4A8DE' });
    const blob = g.getSerializedGraph();
    expect(blob.config.SECRET_TOKEN.value).toBe('sk-live-9f2b71c4a8de');
    expect(blob.config.SECRET_TOKEN.overrideStr).toBeUndefined();
  });
});
