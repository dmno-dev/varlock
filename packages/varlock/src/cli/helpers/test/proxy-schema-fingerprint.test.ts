import { describe, expect, test } from 'vitest';
import outdent from 'outdent';

import { DotEnvFileDataSource, EnvGraph } from '../../../env-graph';
import { buildProxySchemaFingerprint } from '../proxy-schema-fingerprint';

async function fp(envFile: string): Promise<string> {
  const graph = new EnvGraph();
  await graph.setRootDataSource(new DotEnvFileDataSource('.env.schema', { overrideContents: envFile }));
  await graph.finishLoad();
  await graph.resolveEnvValues();
  return buildProxySchemaFingerprint(graph);
}

const BASE = outdent`
  # @enableProxy(egress="strict")
  # ---
  # @sensitive @proxy(domain="api.x.com", approval=true)
  SECRET=abc
`;

describe('buildProxySchemaFingerprint', () => {
  test('identical schemas → identical fingerprint', async () => {
    expect(await fp(BASE)).toBe(await fp(BASE));
  });

  test('decorator order, named-arg order, comments, and whitespace do not affect it', async () => {
    const reordered = outdent`
      # @enableProxy(egress="strict")
      # ---
      # a comment that should be ignored
      # @proxy(approval=true, domain="api.x.com")  @sensitive
      SECRET=abc
    `;
    expect(await fp(reordered)).toBe(await fp(BASE));
  });

  test('an inert decorator (@example) does not change it', async () => {
    const withExample = outdent`
      # @enableProxy(egress="strict")
      # ---
      # @sensitive @proxy(domain="api.x.com", approval=true) @example=placeholder-ish
      SECRET=abc
    `;
    expect(await fp(withExample)).toBe(await fp(BASE));
  });

  test('changing the @proxy domain changes it', async () => {
    expect(await fp(BASE.replace('api.x.com', 'api.y.com'))).not.toBe(await fp(BASE));
  });

  test('a single value and a single-element array are identical (domain=a ≡ domain=[a])', async () => {
    const single = outdent`
      # @enableProxy(egress="strict")
      # ---
      # @sensitive @proxy(domain="api.x.com")
      SECRET=abc
    `;
    const arrayOfOne = outdent`
      # @enableProxy(egress="strict")
      # ---
      # @sensitive @proxy(domain=["api.x.com"])
      SECRET=abc
    `;
    expect(await fp(arrayOfOne)).toBe(await fp(single));
    // but a real multi-element list is still distinct
    const arrayOfTwo = single.replace('domain="api.x.com"', 'domain=[api.x.com, api.y.com]');
    expect(await fp(arrayOfTwo)).not.toBe(await fp(single));
  });

  test('changing approval config changes it', async () => {
    const capped = BASE.replace('approval=true', 'approval=true, approvalMaxDuration="15m"');
    expect(await fp(capped)).not.toBe(await fp(BASE));
  });

  test('flipping proxied → passthrough changes it (the gap the old shape-only fingerprint missed)', async () => {
    const passthrough = outdent`
      # @enableProxy(egress="strict")
      # ---
      # @sensitive
      # @proxy=passthrough
      SECRET=abc
    `;
    expect(await fp(passthrough)).not.toBe(await fp(BASE));
  });

  test('changing the value definition changes it', async () => {
    expect(await fp(BASE.replace('SECRET=abc', 'SECRET=def'))).not.toBe(await fp(BASE));
  });

  test('changing the egress mode (root decorator) changes it', async () => {
    expect(await fp(BASE.replace('strict', 'permissive'))).not.toBe(await fp(BASE));
  });
});
