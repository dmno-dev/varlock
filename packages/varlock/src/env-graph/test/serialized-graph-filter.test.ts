import { describe, it, expect } from 'vitest';
import outdent from 'outdent';
import { EnvGraph } from '../index';
import { DotEnvFileDataSource } from '../lib/data-source';
import { SERIALIZED_ENV_GRAPH_FORMAT_VERSION } from '../lib/env-graph';
import { VARLOCK_VERSION, VARLOCK_VERSION_ID } from '../../lib/varlock-version';

async function loadSchema(contents: string, overrideValues?: Record<string, string>) {
  const g = new EnvGraph();
  await g.setRootDataSource(new DotEnvFileDataSource('.env.schema', { overrideContents: contents }));
  await g.finishLoad();
  if (overrideValues) g.overrideValues = overrideValues;
  await g.resolveEnvValues();
  return g;
}

describe('getSerializedGraph version stamps', () => {
  it('records the format version and the producing varlock version', async () => {
    const g = await loadSchema('FOO=bar');
    const blob = g.getSerializedGraph();
    expect(blob.blobFormatVersion).toBe(SERIALIZED_ENV_GRAPH_FORMAT_VERSION);
    // the build-type suffix is part of the stamp outside release builds, so under vitest
    // this is the bare version plus `-test`
    expect(blob.varlockVersion).toBe(VARLOCK_VERSION_ID);
    expect(VARLOCK_VERSION_ID).toMatch(new RegExp(`^${VARLOCK_VERSION}(-|$)`));
    expect(VARLOCK_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('getSerializedGraph filterKeys', () => {
  it('excludes filtered-out items from config but keeps selected ones', async () => {
    const g = await loadSchema(outdent`
      STRIPE_KEY=abc  # @public
      OTHER_VAR=def   # @public
    `);
    const blob = g.getSerializedGraph({ filterKeys: new Set(['STRIPE_KEY']) });
    expect(blob.config).toHaveProperty('STRIPE_KEY');
    expect(blob.config).not.toHaveProperty('OTHER_VAR');
  });

  it('excludes filtered-out items from override provenance metadata too', async () => {
    const g = await loadSchema(outdent`
      STRIPE_KEY=abc  # @public
      OTHER_VAR=def   # @public
    `, { STRIPE_KEY: 'from-env', OTHER_VAR: 'also-from-env' });
    const blob = g.getSerializedGraph({ filterKeys: new Set(['STRIPE_KEY']) });
    // OTHER_VAR isn't in the blob's config, so its override provenance would be pure
    // noise - and would leak the excluded key's name into the blob
    expect(blob.overrideKeys).toEqual(['STRIPE_KEY']);
  });

  it('keeps full override provenance when no filter is set', async () => {
    const g = await loadSchema(outdent`
      STRIPE_KEY=abc  # @public
      OTHER_VAR=def   # @public
    `, { STRIPE_KEY: 'from-env', OTHER_VAR: 'also-from-env' });
    const blob = g.getSerializedGraph();
    expect(blob.overrideKeys).toEqual(['STRIPE_KEY', 'OTHER_VAR']);
  });
});
