import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { DotEnvFileDataSource, EnvGraph } from '../env-graph/index';

/**
 * Loads the `env-spec` examples straight out of the PUBLISHED docs, so a
 * snippet that drifts from the implemented syntax fails here rather than
 * shipping. Deriving the input from the .mdx (instead of copying it) is the
 * point: a copy can regress independently of what readers see.
 */
const DOCS_DIR = path.resolve(__dirname, '../../../varlock-website/src/content/docs');
const RULES_GUIDE = path.join(DOCS_DIR, 'guides/proxy/rules.mdx');

/** Every ```env-spec fenced block in a docs file. */
function extractEnvSpecBlocks(filePath: string): Array<string> {
  const source = readFileSync(filePath, 'utf8');
  return [...source.matchAll(/```env-spec[^\n]*\n([\s\S]*?)```/g)].map((match) => match[1].trimEnd());
}

/**
 * Snippets are loadable as-is when they declare items. A few illustrate only
 * header decorators, which need an item to attach the file's `# ---` divider
 * semantics to; those are skipped rather than doctored.
 */
function isLoadableSchema(block: string): boolean {
  return /^[A-Z][A-Z0-9_]*=/m.test(block);
}

/** Schemes provided by plugins are covered by the plugin's own tests. */
function usesOnlyBuiltInSchemes(block: string): boolean {
  const schemes = [...block.matchAll(/scheme="([^"]+)"/g)].map((match) => match[1]);
  return schemes.every((scheme) => ['hmac-sha256', 'hmac-sha512', 'http-basic'].includes(scheme));
}

/**
 * Docs use stand-in resolvers (`yourPreferredPlugin()`) to stay vendor-neutral.
 * Swap them for a literal so the snippet can actually load; the transform
 * syntax under test is untouched.
 */
function normalizeStandInResolvers(block: string): string {
  return block.replace(/(?:yourPreferredPlugin|somePlugin)\(\)/g, 'docs-example-value');
}

async function loadSchema(envFile: string) {
  const graph = new EnvGraph();
  await graph.setRootDataSource(new DotEnvFileDataSource('.env.schema', { overrideContents: normalizeStandInResolvers(envFile) }));
  await graph.finishLoad();
  await graph.resolveEnvValues();
  return graph;
}

describe('published docs examples load and keep credentials out of rule data', () => {
  const transformBlocks = extractEnvSpecBlocks(RULES_GUIDE)
    .filter((block) => block.includes('transform='))
    .filter(isLoadableSchema)
    .filter(usesOnlyBuiltInSchemes);

  // guards against the filters silently reducing this to nothing
  test('found transform examples to check', () => {
    expect(transformBlocks.length).toBeGreaterThanOrEqual(3);
  });

  transformBlocks.forEach((block, index) => {
    const firstLine = block.split('\n').find((line) => line.includes('domain=')) ?? `block ${index}`;
    test(`loads: ${firstLine.trim().slice(0, 72)}`, async () => {
      const graph = await loadSchema(block);
      // the snippet must be free of schema errors, not merely parseable
      const decoratorErrors = Object.values(graph.configSchema)
        .flatMap((item) => item.decoratorSchemaErrors.map((err) => err.message));
      expect(decoratorErrors).toEqual([]);

      const rules = await graph.getProxyRules();
      expect(rules.some((rule) => rule.transform !== undefined)).toBe(true);

      // no item's resolved value may appear anywhere in the rules
      const serializedRules = JSON.stringify(rules);
      for (const item of Object.values(graph.configSchema)) {
        const value = item.resolvedValue;
        if (typeof value === 'string' && value.length > 3) {
          expect(serializedRules).not.toContain(value);
        }
      }
    });
  });
});
