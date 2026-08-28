import { describe, expect, test } from 'vitest';
import outdent from 'outdent';
import { DotEnvFileDataSource, EnvGraph } from '../env-graph/index';

/** The three built-in-scheme examples exactly as the docs show them. */
const DOC_EXAMPLES: Record<string, string> = {
  hmac: outdent`
    # @proxy(domain="api.exchange.com", transform={
    #   scheme="hmac-sha256",
    #   stringToSign="{timestamp}{method}{pathWithQuery}{body}",
    #   signatureHeader="X-ACCESS-SIGN",
    #   timestampHeader="X-ACCESS-TIMESTAMP",
    #   keyId=$EXCHANGE_API_KEY, keyHeader="X-ACCESS-KEY",
    #   encoding="hex",
    # })
    EXCHANGE_API_SECRET=some-secret

    # @sensitive
    EXCHANGE_API_KEY=some-key
  `,
  httpBasicAttached: outdent`
    # ---
    # @proxy(domain="registry.example.com", transform={scheme="http-basic", username="ci-bot"})
    REGISTRY_PASSWORD=some-password
  `,
  httpBasicDetached: outdent`
    # @proxy(domain="registry.example.com", transform={
    #   scheme="http-basic", password=$REGISTRY_PASSWORD, username=$REGISTRY_USER,
    # })
    # ---
    # @sensitive
    REGISTRY_PASSWORD=some-password

    REGISTRY_USER=ci-bot
  `,
};

describe('docs examples load cleanly', () => {
  for (const [name, envFile] of Object.entries(DOC_EXAMPLES)) {
    test(name, async () => {
      const graph = new EnvGraph();
      await graph.setRootDataSource(new DotEnvFileDataSource('.env.schema', { overrideContents: envFile }));
      await graph.finishLoad();
      await graph.resolveEnvValues();
      const rules = await graph.getProxyRules();
      expect(rules[0]?.transform).toBeDefined();
      // no credential VALUE ever lands in rule data
      expect(JSON.stringify(rules)).not.toContain('some-secret');
      expect(JSON.stringify(rules)).not.toContain('some-password');
    });
  }
});
