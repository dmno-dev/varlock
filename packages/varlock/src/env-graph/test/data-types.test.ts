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
    it('accepts url matching quoted regex pattern', async () => {
      const g = await loadAndResolve(outdent`
        # @type=url(matches="^https://api\\.")
        MY_URL=https://api.example.com
      `);
      expect(g.configSchema.MY_URL.isValid).toBe(true);
    });

    it('rejects url not matching quoted regex pattern', async () => {
      const g = await loadAndResolve(outdent`
        # @type=url(matches="^https://api\\.")
        MY_URL=https://example.com
      `);
      expect(g.configSchema.MY_URL.isValid).toBe(false);
    });

    it('accepts url matching unquoted regex-like pattern', async () => {
      const g = await loadAndResolve(outdent`
        # @type=url(matches=/^https://api\\./)
        MY_URL=https://api.example.com
      `);
      expect(g.configSchema.MY_URL.isValid).toBe(true);
    });

    it('rejects url not matching unquoted regex-like pattern', async () => {
      const g = await loadAndResolve(outdent`
        # @type=url(matches=/^https://api\\./)
        MY_URL=https://example.com
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
        # @type=url(noTrailingSlash=true, matches="^https://api\\.")
        GOOD_URL=https://api.example.com/v1
        # @type=url(noTrailingSlash=true, matches="^https://api\\.")
        BAD_SLASH=https://api.example.com/v1/
        # @type=url(noTrailingSlash=true, matches="^https://api\\.")
        BAD_DOMAIN=https://example.com/v1
      `);
      expect(g.configSchema.GOOD_URL.isValid).toBe(true);
      expect(g.configSchema.BAD_SLASH.isValid).toBe(false);
      expect(g.configSchema.BAD_DOMAIN.isValid).toBe(false);
    });
  });
});

describe('url data type - path values', () => {
  it('accepts url with path segments', async () => {
    const g = await loadAndResolve(outdent`
      # @type=url
      MY_URL=https://example.com/foo/bar/baz
    `);
    expect(g.configSchema.MY_URL.isValid).toBe(true);
    expect(g.configSchema.MY_URL.resolvedValue).toBe('https://example.com/foo/bar/baz');
  });

  it('accepts url with path and quoted regex pattern', async () => {
    const g = await loadAndResolve(outdent`
      # @type=url(matches="^https://example\\.com/api/")
      MY_URL=https://example.com/api/v1
    `);
    expect(g.configSchema.MY_URL.isValid).toBe(true);
  });

  it('rejects url not matching path-based quoted regex pattern', async () => {
    const g = await loadAndResolve(outdent`
      # @type=url(matches="^https://example\\.com/api/")
      MY_URL=https://other.com/api/v1
    `);
    expect(g.configSchema.MY_URL.isValid).toBe(false);
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

describe('duration data type', () => {
  describe('output unit', () => {
    it('defaults to milliseconds', async () => {
      const g = await loadAndResolve(outdent`
        # @type=duration
        TIMEOUT=1h
      `);
      expect(g.configSchema.TIMEOUT.isValid).toBe(true);
      expect(g.configSchema.TIMEOUT.resolvedValue).toBe(3_600_000);
    });

    it('supports seconds output', async () => {
      const g = await loadAndResolve(outdent`
        # @type=duration(output="seconds")
        TIMEOUT=1h
      `);
      expect(g.configSchema.TIMEOUT.isValid).toBe(true);
      expect(g.configSchema.TIMEOUT.resolvedValue).toBe(3600);
    });

    it('supports minutes output', async () => {
      const g = await loadAndResolve(outdent`
        # @type=duration(output="minutes")
        TIMEOUT=2h
      `);
      expect(g.configSchema.TIMEOUT.resolvedValue).toBe(120);
    });

    it('supports days output for week input', async () => {
      const g = await loadAndResolve(outdent`
        # @type=duration(output="days")
        EXPIRY=2w
      `);
      expect(g.configSchema.EXPIRY.resolvedValue).toBe(14);
    });

    it('rejects invalid output unit', async () => {
      const g = await loadAndResolve(outdent`
        # @type=duration(output="lightyears")
        BAD=1h
      `);
      expect(g.configSchema.BAD.isValid).toBe(false);
    });
  });

  describe('input formats', () => {
    it('accepts long-form units', async () => {
      const g = await loadAndResolve(outdent`
        # @type=duration(output="minutes")
        T=2hours
      `);
      expect(g.configSchema.T.resolvedValue).toBe(120);
    });

    it('accepts bare-number ms strings', async () => {
      const g = await loadAndResolve(outdent`
        # @type=duration
        T=5000
      `);
      expect(g.configSchema.T.resolvedValue).toBe(5000);
    });

    it('rejects garbage', async () => {
      const g = await loadAndResolve(outdent`
        # @type=duration
        T=banana
      `);
      expect(g.configSchema.T.isValid).toBe(false);
    });
  });

  describe('min/max validation', () => {
    it('enforces min', async () => {
      const g = await loadAndResolve(outdent`
        # @type=duration(min="5m")
        T=1m
      `);
      expect(g.configSchema.T.isValid).toBe(false);
    });

    it('accepts value within bounds', async () => {
      const g = await loadAndResolve(outdent`
        # @type=duration(min="5m", max="1h")
        T=10m
      `);
      expect(g.configSchema.T.isValid).toBe(true);
    });

    it('enforces max', async () => {
      const g = await loadAndResolve(outdent`
        # @type=duration(max="1h")
        T=2h
      `);
      expect(g.configSchema.T.isValid).toBe(false);
    });

    it('compares bounds in the output unit', async () => {
      // 1500ms input → output 1.5s, max 2s → should pass
      const g = await loadAndResolve(outdent`
        # @type=duration(output="seconds", max="2s")
        T=1500ms
      `);
      expect(g.configSchema.T.isValid).toBe(true);
      expect(g.configSchema.T.resolvedValue).toBe(1.5);
    });
  });
});
