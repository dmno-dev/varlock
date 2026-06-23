import { describe, it, expect } from 'vitest';
import outdent from 'outdent';
import { EnvGraph } from '../index';
import { DotEnvFileDataSource } from '../lib/data-source';
import { createEnvGraphDataType } from '../lib/data-types';
import { createResolver } from '../lib/resolver';

// a fake resolver that implies sensitivity (like varlock()/keychain() do)
const SecretResolver = createResolver({
  name: 'mysecret',
  impliesSensitive: true,
  resolve() { return 'shhh'; },
});

async function load(contents: string, opts?: { withTypeAndResolver?: boolean }) {
  const g = new EnvGraph();
  if (opts?.withTypeAndResolver) {
    g.registerDataType(createEnvGraphDataType({ name: 'svc-token', sensitive: true, internal: true }));
    g.registerResolver(SecretResolver);
  }
  await g.setRootDataSource(new DotEnvFileDataSource('.env.schema', { overrideContents: contents }));
  await g.finishLoad();
  await g.resolveEnvValues();
  return g;
}

describe('sensitivity / internal provenance (for `varlock explain`)', () => {
  it('reports an explicit @sensitive / @internal as "explicit"', async () => {
    const g = await load(outdent`
      # @sensitive @internal
      TOKEN=abc
    `);
    expect(g.configSchema.TOKEN.sensitiveSource).toBe('explicit');
    expect(g.configSchema.TOKEN.internalSource).toBe('explicit');
  });

  it('reports sensitivity / internal implied by the data type as "data-type"', async () => {
    const g = await load(outdent`
      # @type=svc-token
      TOKEN=abc
    `, { withTypeAndResolver: true });
    expect(g.configSchema.TOKEN.sensitiveSource).toBe('data-type');
    expect(g.configSchema.TOKEN.internalSource).toBe('data-type');
  });

  it('reports sensitivity inferred from the resolver as "resolver"', async () => {
    const g = await load(outdent`
      # @defaultSensitive=false
      # ---
      SECRET=mysecret()
    `, { withTypeAndResolver: true });
    expect(g.configSchema.SECRET.isSensitive).toBe(true);
    expect(g.configSchema.SECRET.sensitiveSource).toBe('resolver');
  });

  it('falls back to "default" sensitivity and undefined internal source', async () => {
    const g = await load(outdent`
      PLAIN=hello
    `);
    expect(g.configSchema.PLAIN.sensitiveSource).toBe('default');
    expect(g.configSchema.PLAIN.internalSource).toBeUndefined();
  });
});
