/*
  Test data type coercion and validation

  These tests exercise the @type decorator with various data type options,
  ensuring values are correctly coerced and validated through the full
  env-graph pipeline.
*/

import { describe, it, expect } from 'vitest';
import { outdent } from 'outdent';
import { DotEnvFileDataSource, EnvGraph } from '../index';

async function loadAndResolve(envFileContent: string) {
  const g = new EnvGraph();
  const testDataSource = new DotEnvFileDataSource('.env.schema', {
    overrideContents: outdent`
      # @defaultRequired=false
      # ---
      ${envFileContent}
    `,
  });
  await g.setRootDataSource(testDataSource);
  await g.finishLoad();
  await g.resolveEnvValues();
  return g;
}

describe('url data type', () => {
  describe('prependHttps', () => {
    it('prepends https:// when missing', async () => {
      const g = await loadAndResolve(outdent`
        # @type=url(prependHttps=true)
        MY_URL=example.com/foobar
      `);
      expect(g.configSchema.MY_URL.isValid).toBe(true);
      expect(g.configSchema.MY_URL.resolvedValue).toBe('https://example.com/foobar');
    });

    it('does not prepend when https:// already present', async () => {
      const g = await loadAndResolve(outdent`
        # @type=url(prependHttps=true)
        MY_URL=https://example.com
      `);
      expect(g.configSchema.MY_URL.isValid).toBe(true);
      expect(g.configSchema.MY_URL.resolvedValue).toBe('https://example.com');
    });
  });

  describe('noTrailingSlash', () => {
    it('accepts url without trailing slash', async () => {
      const g = await loadAndResolve(outdent`
        # @type=url(noTrailingSlash=true)
        MY_URL=https://example.com/path
      `);
      expect(g.configSchema.MY_URL.isValid).toBe(true);
    });

    it('rejects url with trailing slash', async () => {
      const g = await loadAndResolve(outdent`
        # @type=url(noTrailingSlash=true)
        MY_URL=https://example.com/path/
      `);
      expect(g.configSchema.MY_URL.isValid).toBe(false);
    });

    it('rejects bare domain with trailing slash', async () => {
      const g = await loadAndResolve(outdent`
        # @type=url(noTrailingSlash=true)
        MY_URL=https://example.com/
      `);
      expect(g.configSchema.MY_URL.isValid).toBe(false);
    });

    it('accepts bare domain without trailing slash', async () => {
      const g = await loadAndResolve(outdent`
        # @type=url(noTrailingSlash=true)
        MY_URL=https://example.com
      `);
      expect(g.configSchema.MY_URL.isValid).toBe(true);
    });
  });

  describe('matches', () => {
    it('accepts url matching regex literal', async () => {
      const g = await loadAndResolve(outdent`
        # @type=url(matches=/^https:\\/\\/api\\./)
        MY_URL=https://api.example.com
      `);
      expect(g.configSchema.MY_URL.isValid).toBe(true);
    });

    it('rejects url not matching regex literal', async () => {
      const g = await loadAndResolve(outdent`
        # @type=url(matches=/^https:\\/\\/api\\./)
        MY_URL=https://example.com
      `);
      expect(g.configSchema.MY_URL.isValid).toBe(false);
    });

    it('accepts url matching string pattern', async () => {
      const g = await loadAndResolve(outdent`
        # @type=url(matches="^https://")
        MY_URL=https://example.com
      `);
      expect(g.configSchema.MY_URL.isValid).toBe(true);
    });

    it('rejects url not matching string pattern', async () => {
      const g = await loadAndResolve(outdent`
        # @type=url(matches="^https://")
        MY_URL=http://example.com
      `);
      expect(g.configSchema.MY_URL.isValid).toBe(false);
    });
  });

  describe('combined options', () => {
    it('applies prependHttps and noTrailingSlash together', async () => {
      const g = await loadAndResolve(outdent`
        # @type=url(prependHttps=true, noTrailingSlash=true)
        GOOD_URL=example.com/path
        # @type=url(prependHttps=true, noTrailingSlash=true)
        BAD_URL=example.com/path/
      `);
      expect(g.configSchema.GOOD_URL.isValid).toBe(true);
      expect(g.configSchema.GOOD_URL.resolvedValue).toBe('https://example.com/path');
      expect(g.configSchema.BAD_URL.isValid).toBe(false);
    });

    it('applies noTrailingSlash and matches together', async () => {
      const g = await loadAndResolve(outdent`
        # @type=url(noTrailingSlash=true, matches=/^https:\\/\\/api\\./)
        GOOD_URL=https://api.example.com/v1
        # @type=url(noTrailingSlash=true, matches=/^https:\\/\\/api\\./)
        BAD_SLASH=https://api.example.com/v1/
        # @type=url(noTrailingSlash=true, matches=/^https:\\/\\/api\\./)
        BAD_DOMAIN=https://example.com/v1
      `);
      expect(g.configSchema.GOOD_URL.isValid).toBe(true);
      expect(g.configSchema.BAD_SLASH.isValid).toBe(false);
      expect(g.configSchema.BAD_DOMAIN.isValid).toBe(false);
    });
  });
});

describe('string data type - matches option', () => {
  it('accepts string matching regex literal', async () => {
    const g = await loadAndResolve(outdent`
      # @type=string(matches=/^[A-Z]+$/)
      MY_VAR=HELLO
    `);
    expect(g.configSchema.MY_VAR.isValid).toBe(true);
  });

  it('rejects string not matching regex literal', async () => {
    const g = await loadAndResolve(outdent`
      # @type=string(matches=/^[A-Z]+$/)
      MY_VAR=hello
    `);
    expect(g.configSchema.MY_VAR.isValid).toBe(false);
  });

  it('supports regex flags in literal', async () => {
    const g = await loadAndResolve(outdent`
      # @type=string(matches=/^hello$/i)
      MY_VAR=HELLO
    `);
    expect(g.configSchema.MY_VAR.isValid).toBe(true);
  });
});
