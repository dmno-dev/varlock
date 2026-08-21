import { describe, it, expect } from 'vitest';
import outdent from 'outdent';
import { EnvGraph } from '../index';
import { DotEnvFileDataSource } from '../lib/data-source';
import { hashEnvSourceContents } from '../../lib/env-source-fingerprint';

describe('getSerializedGraph source fingerprints', () => {
  it('records a contentHash of the parsed contents for file-based sources', async () => {
    const contents = outdent`
      FOO=bar
    `;
    const g = new EnvGraph();
    await g.setRootDataSource(new DotEnvFileDataSource('.env.schema', { overrideContents: contents }));
    await g.finishLoad();
    await g.resolveEnvValues();

    const blob = g.getSerializedGraph();
    expect(blob.sources).toHaveLength(1);
    expect(blob.sources[0].contentHash).toBe(hashEnvSourceContents(contents));
  });
});
