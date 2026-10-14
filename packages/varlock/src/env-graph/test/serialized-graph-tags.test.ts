import { describe, it, expect } from 'vitest';
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

describe('tags in the serialized graph', () => {
  const schema = outdent`
    # @tag(deploy)
    CLOUDFLARE_ACCOUNT_ID=acct
    # @tag(server, web)
    SHARED=x
    UNTAGGED=y
  `;

  it('are emitted with includeTags (json-full), only for tagged items', async () => {
    const g = await loadSchema(schema);
    const inspect = g.getSerializedGraph({ includeTags: true });
    expect(inspect.config.CLOUDFLARE_ACCOUNT_ID.tags).toEqual(['deploy']);
    expect(inspect.config.SHARED.tags).toEqual(['server', 'web']);
    expect(inspect.config.UNTAGGED.tags).toBeUndefined();
  });

  it('are left out of the default (runtime blob) serialization', async () => {
    const g = await loadSchema(schema);
    const blob = g.getSerializedGraph();
    expect(blob.config.CLOUDFLARE_ACCOUNT_ID.tags).toBeUndefined();
    expect(blob.config.SHARED.tags).toBeUndefined();
  });
});
