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

describe('array data type', () => {
  it('coerces array literal string values', async () => {
    const g = await loadAndResolve(outdent`
      # @type=array(string)
      ITEM=[alpha, beta]
    `);
    expect(g.configSchema.ITEM.isValid).toBe(true);
    expect(g.configSchema.ITEM.resolvedValue).toEqual(['alpha', 'beta']);
  });

  it('validates each element with element type', async () => {
    const g = await loadAndResolve(outdent`
      # @type=array(email)
      ITEM=[good@example.com, not-an-email]
    `);
    expect(g.configSchema.ITEM.isValid).toBe(false);
    expect(g.configSchema.ITEM.validationErrors?.[0]?.message).toContain('[1]');
  });

  it('normalizes emails when element options are forwarded', async () => {
    const g = await loadAndResolve(outdent`
      # @type=array(email, normalize=true)
      ITEM=[User@Example.com]
    `);
    expect(g.configSchema.ITEM.isValid).toBe(true);
    expect(g.configSchema.ITEM.resolvedValue).toEqual(['user@example.com']);
  });

  it('supports nested enum element type', async () => {
    const g = await loadAndResolve(outdent`
      # @type=array(enum(sandbox, whitelist, production))
      ITEM=[sandbox, whitelist]
    `);
    expect(g.configSchema.ITEM.isValid).toBe(true);
    expect(g.configSchema.ITEM.resolvedValue).toEqual(['sandbox', 'whitelist']);
  });

  it('rejects invalid enum values in array', async () => {
    const g = await loadAndResolve(outdent`
      # @type=array(enum(sandbox, whitelist, production))
      ITEM=[sandbox, invalid]
    `);
    expect(g.configSchema.ITEM.isValid).toBe(false);
  });

  it('parses comma-separated input with separator option', async () => {
    const g = await loadAndResolve(outdent`
      # @type=array(email, separator=",")
      ITEM=one@example.com, two@example.com
    `);
    expect(g.configSchema.ITEM.isValid).toBe(true);
    expect(g.configSchema.ITEM.resolvedValue).toEqual(['one@example.com', 'two@example.com']);
  });

  it('parses JSON array strings', async () => {
    const g = await loadAndResolve(outdent`
      # @type=array(string)
      ITEM=["a", "b"]
    `);
    expect(g.configSchema.ITEM.isValid).toBe(true);
    expect(g.configSchema.ITEM.resolvedValue).toEqual(['a', 'b']);
  });

  it('rejects empty arrays by default', async () => {
    const g = await loadAndResolve(outdent`
      # @type=array(string)
      ITEM=[]
    `);
    expect(g.configSchema.ITEM.isValid).toBe(false);
  });

  it('allows empty arrays when allowEmpty=true', async () => {
    const g = await loadAndResolve(outdent`
      # @type=array(string, allowEmpty=true)
      ITEM=[]
    `);
    expect(g.configSchema.ITEM.isValid).toBe(true);
    expect(g.configSchema.ITEM.resolvedValue).toEqual([]);
  });

  it('enforces minLength and maxLength', async () => {
    const g = await loadAndResolve(outdent`
      # @type=array(string, minLength=2, maxLength=3)
      ITEM=[a, b, c, d]
    `);
    expect(g.configSchema.ITEM.isValid).toBe(false);
  });

  it('enforces unique elements', async () => {
    const g = await loadAndResolve(outdent`
      # @type=array(string, unique=true)
      ITEM=[dup, dup]
    `);
    expect(g.configSchema.ITEM.isValid).toBe(false);
  });

  it('validates array of emails with element options and conditional required', async () => {
    const g = await loadAndResolve(outdent`
      # @type=enum(sandbox, restricted, production)
      APP_MODE=sandbox
      # @type=array(email, normalize=true)
      # @required=eq($APP_MODE, restricted)
      ALLOWED_EMAILS=[admin@example.com, support@example.com]
    `);
    expect(g.configSchema.ALLOWED_EMAILS.isValid).toBe(true);
    expect(g.configSchema.ALLOWED_EMAILS.resolvedValue).toEqual([
      'admin@example.com',
      'support@example.com',
    ]);
  });

  describe('non-string element types', () => {
    it('coerces array of numbers from literals', async () => {
      const g = await loadAndResolve(outdent`
        # @type=array(number)
        PORTS=[8080, 3000, 443]
      `);
      expect(g.configSchema.PORTS.isValid).toBe(true);
      expect(g.configSchema.PORTS.resolvedValue).toEqual([8080, 3000, 443]);
    });

    it('coerces array of numbers from JSON array strings', async () => {
      const g = await loadAndResolve(outdent`
        # @type=array(number)
        SCORES="[10, 20, 30]"
      `);
      expect(g.configSchema.SCORES.isValid).toBe(true);
      expect(g.configSchema.SCORES.resolvedValue).toEqual([10, 20, 30]);
    });

    it('forwards number element options (min/max)', async () => {
      const g = await loadAndResolve(outdent`
        # @type=array(number, min=0, max=100)
        PERCENTS=[0, 50, 100]
      `);
      expect(g.configSchema.PERCENTS.isValid).toBe(true);
      expect(g.configSchema.PERCENTS.resolvedValue).toEqual([0, 50, 100]);
    });

    it('rejects numbers outside forwarded element bounds', async () => {
      const g = await loadAndResolve(outdent`
        # @type=array(number, min=0, max=100)
        PERCENTS=[50, 150]
      `);
      expect(g.configSchema.PERCENTS.isValid).toBe(false);
      expect(g.configSchema.PERCENTS.validationErrors?.[0]?.message).toContain('[1]');
    });

    it('coerces array of booleans from literals', async () => {
      const g = await loadAndResolve(outdent`
        # @type=array(boolean)
        FLAGS=[true, false, 1, 0]
      `);
      expect(g.configSchema.FLAGS.isValid).toBe(true);
      expect(g.configSchema.FLAGS.resolvedValue).toEqual([true, false, true, false]);
    });

    it('coerces array of booleans from JSON array strings', async () => {
      const g = await loadAndResolve(outdent`
        # @type=array(boolean)
        FLAGS="[true, false]"
      `);
      expect(g.configSchema.FLAGS.isValid).toBe(true);
      expect(g.configSchema.FLAGS.resolvedValue).toEqual([true, false]);
    });

    it('validates array of ports with element constraints', async () => {
      const g = await loadAndResolve(outdent`
        # @type=array(port, min=1024, max=9999)
        PORTS=[8080, 3000]
      `);
      expect(g.configSchema.PORTS.isValid).toBe(true);
      expect(g.configSchema.PORTS.resolvedValue).toEqual([8080, 3000]);
    });

    it('rejects ports outside element port range', async () => {
      const g = await loadAndResolve(outdent`
        # @type=array(port, min=1024)
        PORTS=[8080, 80]
      `);
      expect(g.configSchema.PORTS.isValid).toBe(false);
      expect(g.configSchema.PORTS.validationErrors?.[0]?.message).toContain('[1]');
    });

    it('validates array of UUIDs', async () => {
      const g = await loadAndResolve(outdent`
        # @type=array(uuid)
        IDS=[
          123e4567-e89b-12d3-a456-426614174000,
          00000000-0000-4000-8000-000000000000,
        ]
      `);
      expect(g.configSchema.IDS.isValid).toBe(true);
      expect(g.configSchema.IDS.resolvedValue).toEqual([
        '123e4567-e89b-12d3-a456-426614174000',
        '00000000-0000-4000-8000-000000000000',
      ]);
    });

    it('rejects invalid UUIDs with indexed errors', async () => {
      const g = await loadAndResolve(outdent`
        # @type=array(uuid)
        IDS=[123e4567-e89b-12d3-a456-426614174000, not-a-uuid]
      `);
      expect(g.configSchema.IDS.isValid).toBe(false);
      expect(g.configSchema.IDS.validationErrors?.[0]?.message).toContain('[1]');
    });

    it('supports nested enum of non-string values', async () => {
      const g = await loadAndResolve(outdent`
        # @type=array(enum(1, 2, 3))
        LEVELS=[1, 2, 3]
      `);
      expect(g.configSchema.LEVELS.isValid).toBe(true);
      expect(g.configSchema.LEVELS.resolvedValue).toEqual([1, 2, 3]);
    });

    it('rejects invalid entries in nested numeric enum array', async () => {
      const g = await loadAndResolve(outdent`
        # @type=array(enum(1, 2, 3))
        LEVELS=[1, 4]
      `);
      expect(g.configSchema.LEVELS.isValid).toBe(false);
    });

    it('parses comma-separated numbers with separator option', async () => {
      const g = await loadAndResolve(outdent`
        # @type=array(number, separator=",")
        VALUES=10, 20, 30
      `);
      expect(g.configSchema.VALUES.isValid).toBe(true);
      expect(g.configSchema.VALUES.resolvedValue).toEqual([10, 20, 30]);
    });
  });
});
