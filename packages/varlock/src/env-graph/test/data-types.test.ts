/*
  Test data type coercion and validation

  These tests exercise the @type decorator with various data type options,
  ensuring values are correctly coerced and validated through the full
  env-graph pipeline.
*/

import { describe, it, expect } from 'vitest';
import { outdent } from 'outdent';
import { DotEnvFileDataSource, EnvGraph, CoercionError } from '../index';

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

describe('number data type - Infinity coercion', () => {
  const numberType = () => new EnvGraph().dataTypesRegistry.number();

  it('rejects numeric Infinity', () => {
    expect(() => numberType().coerce(Infinity)).toThrow(CoercionError);
    expect(() => numberType().coerce(Infinity)).toThrow(/Infinity is not a valid number/);
  });

  it('rejects numeric -Infinity', () => {
    expect(() => numberType().coerce(-Infinity)).toThrow(CoercionError);
    expect(() => numberType().coerce(-Infinity)).toThrow(/Infinity is not a valid number/);
  });

  it('rejects string Infinity and -Infinity', () => {
    expect(() => numberType().coerce('Infinity')).toThrow(CoercionError);
    expect(() => numberType().coerce('-Infinity')).toThrow(CoercionError);
  });
});

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
  describe('input forms', () => {
    it('coerces native array literal values', async () => {
      const g = await loadAndResolve(outdent`
        # @type=array(string)
        ITEM=[alpha, beta]
      `);
      expect(g.configSchema.ITEM.isValid).toBe(true);
      expect(g.configSchema.ITEM.resolvedValue).toEqual(['alpha', 'beta']);
    });

    it('parses JSON array strings', async () => {
      const g = await loadAndResolve(outdent`
        # @type=array(string)
        ITEM='["a", "b"]'
      `);
      expect(g.configSchema.ITEM.isValid).toBe(true);
      expect(g.configSchema.ITEM.resolvedValue).toEqual(['a', 'b']);
    });

    it('splits plain strings on the default comma separator', async () => {
      const g = await loadAndResolve(outdent`
        # @type=array(email)
        ITEM="one@example.com, two@example.com"
      `);
      expect(g.configSchema.ITEM.isValid).toBe(true);
      expect(g.configSchema.ITEM.resolvedValue).toEqual(['one@example.com', 'two@example.com']);
    });

    it('splits on a custom separator', async () => {
      const g = await loadAndResolve(outdent`
        # @type=array(string, separator=";")
        ITEM="a;b;c"
      `);
      expect(g.configSchema.ITEM.isValid).toBe(true);
      expect(g.configSchema.ITEM.resolvedValue).toEqual(['a', 'b', 'c']);
    });

    it('errors on malformed JSON array strings instead of splitting them', async () => {
      const g = await loadAndResolve(outdent`
        # @type=array(string)
        ITEM='["a", "b"'
      `);
      expect(g.configSchema.ITEM.isValid).toBe(false);
      expect(g.configSchema.ITEM.coercionError?.message).toContain('JSON');
    });

    it('resolves refs within array literal elements', async () => {
      const g = await loadAndResolve(outdent`
        OTHER=bravo
        # @type=array(string)
        ITEM=[alpha, \${OTHER}]
      `);
      expect(g.configSchema.ITEM.isValid).toBe(true);
      expect(g.configSchema.ITEM.resolvedValue).toEqual(['alpha', 'bravo']);
    });
  });

  describe('element validation', () => {
    it('validates each element with the element type', async () => {
      const g = await loadAndResolve(outdent`
        # @type=array(email)
        ITEM=[good@example.com, not-an-email]
      `);
      expect(g.configSchema.ITEM.isValid).toBe(false);
      expect(g.configSchema.ITEM.validationErrors?.[0]?.message).toContain('[1]');
    });

    it('reports ALL invalid elements, not just the first', async () => {
      const g = await loadAndResolve(outdent`
        # @type=array(email)
        ITEM=[bad-one, good@example.com, bad-two]
      `);
      expect(g.configSchema.ITEM.isValid).toBe(false);
      const messages = (g.configSchema.ITEM.validationErrors ?? []).map((e) => e.message).join('\n');
      expect(messages).toContain('[0]');
      expect(messages).toContain('[2]');
    });

    it('supports element type options via nested call', async () => {
      const g = await loadAndResolve(outdent`
        # @type=array(email(normalize=true))
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

    it('coerces array of numbers from literals', async () => {
      const g = await loadAndResolve(outdent`
        # @type=array(number)
        PORTS=[8080, 3000, 443]
      `);
      expect(g.configSchema.PORTS.isValid).toBe(true);
      expect(g.configSchema.PORTS.resolvedValue).toEqual([8080, 3000, 443]);
    });

    it('coerces array of booleans', async () => {
      const g = await loadAndResolve(outdent`
        # @type=array(boolean)
        FLAGS=[true, false, 1, 0]
      `);
      expect(g.configSchema.FLAGS.isValid).toBe(true);
      expect(g.configSchema.FLAGS.resolvedValue).toEqual([true, false, true, false]);
    });

    it('rejects ports outside nested port constraints', async () => {
      const g = await loadAndResolve(outdent`
        # @type=array(port(min=1024))
        PORTS=[8080, 80]
      `);
      expect(g.configSchema.PORTS.isValid).toBe(false);
      expect(g.configSchema.PORTS.validationErrors?.[0]?.message).toContain('[1]');
    });
  });

  describe('array options', () => {
    it('rejects empty arrays by default', async () => {
      const g = await loadAndResolve(outdent`
        # @type=array(string)
        ITEM=[]
      `);
      expect(g.configSchema.ITEM.isValid).toBe(false);
      const err = g.configSchema.ITEM.validationErrors?.[0];
      expect(err?.message).toContain('must not be empty');
      expect(err?.tip).toContain('minLength=0');
    });

    it('allows empty arrays with explicit minLength=0', async () => {
      const g = await loadAndResolve(outdent`
        # @type=array(string, minLength=0)
        ITEM=[]
      `);
      expect(g.configSchema.ITEM.isValid).toBe(true);
      expect(g.configSchema.ITEM.resolvedValue).toEqual([]);
    });

    it('enforces minLength', async () => {
      const g = await loadAndResolve(outdent`
        # @type=array(string, minLength=1)
        ITEM=[]
      `);
      expect(g.configSchema.ITEM.isValid).toBe(false);
    });

    it('enforces maxLength', async () => {
      const g = await loadAndResolve(outdent`
        # @type=array(string, maxLength=2)
        ITEM=[a, b, c]
      `);
      expect(g.configSchema.ITEM.isValid).toBe(false);
    });

    it('enforces isLength (exact element count)', async () => {
      const good = await loadAndResolve(outdent`
        # @type=array(string, isLength=2)
        ITEM=[a, b]
      `);
      expect(good.configSchema.ITEM.isValid).toBe(true);

      const bad = await loadAndResolve(outdent`
        # @type=array(string, isLength=2)
        ITEM=[a, b, c]
      `);
      expect(bad.configSchema.ITEM.isValid).toBe(false);
      expect(bad.configSchema.ITEM.validationErrors?.[0]?.message).toContain('exactly 2');
    });

    it('enforces unique elements', async () => {
      const g = await loadAndResolve(outdent`
        # @type=array(string, unique=true)
        ITEM=[dup, other, dup]
      `);
      expect(g.configSchema.ITEM.isValid).toBe(false);
      const messages = (g.configSchema.ITEM.validationErrors ?? []).map((e) => e.message).join('\n');
      expect(messages).toContain('[2]');
    });

    it('rejects unknown array options with a helpful message', async () => {
      const g = await loadAndResolve(outdent`
        # @type=array(email, normalize=true)
        ITEM=[a@example.com]
      `);
      expect(g.configSchema.ITEM.isValid).toBe(false);
      expect(g.configSchema.ITEM.errors[0].message).toContain('normalize');
      expect(g.configSchema.ITEM.errors[0].tip).toContain('nested call');
    });

    it('rejects elements containing the separator (no silent bad round-trip)', async () => {
      const g = await loadAndResolve(outdent`
        # @type=array(string)
        ITEM=["has,comma", other]
      `);
      expect(g.configSchema.ITEM.isValid).toBe(false);
      expect(g.configSchema.ITEM.validationErrors?.[0]?.message).toContain('separator');
    });

    it('allows elements containing the separator when format=json', async () => {
      const g = await loadAndResolve(outdent`
        # @type=array(string, format=json)
        ITEM=["has,comma", other]
      `);
      expect(g.configSchema.ITEM.isValid).toBe(true);
      expect(g.configSchema.ITEM.resolvedValue).toEqual(['has,comma', 'other']);
    });
  });

  describe('type inference', () => {
    it('infers array type from an untyped array literal', async () => {
      const g = await loadAndResolve(outdent`
        ITEM=[a, b]
      `);
      expect(g.configSchema.ITEM.isValid).toBe(true);
      expect(g.configSchema.ITEM.dataType?.name).toBe('array');
      expect(g.configSchema.ITEM.resolvedValue).toEqual(['a', 'b']);
    });

    it('infers element type when all elements share a scalar type', async () => {
      const g = await loadAndResolve(outdent`
        PORTS=[8080, 3000]
      `);
      expect(g.configSchema.PORTS.isValid).toBe(true);
      expect(g.configSchema.PORTS.resolvedValue).toEqual([8080, 3000]);
    });

    it('falls back to string elements for mixed literals', async () => {
      const g = await loadAndResolve(outdent`
        MIXED=[1, two]
      `);
      expect(g.configSchema.MIXED.isValid).toBe(true);
      expect(g.configSchema.MIXED.resolvedValue).toEqual(['1', 'two']);
    });
  });

  describe('interplay with other decorators', () => {
    it('works with conditional required', async () => {
      const g = await loadAndResolve(outdent`
        # @type=enum(sandbox, restricted, production)
        APP_MODE=sandbox
        # @type=array(email(normalize=true))
        # @required=eq($APP_MODE, restricted)
        ALLOWED_EMAILS=[admin@example.com, support@example.com]
      `);
      expect(g.configSchema.ALLOWED_EMAILS.isValid).toBe(true);
      expect(g.configSchema.ALLOWED_EMAILS.resolvedValue).toEqual([
        'admin@example.com',
        'support@example.com',
      ]);
    });

    it('required array with no value fails as usual', async () => {
      const g = await loadAndResolve(outdent`
        # @type=array(string)
        # @required
        ITEM=
      `);
      expect(g.configSchema.ITEM.isValid).toBe(false);
    });
  });
});

describe('record data type', () => {
  describe('input forms', () => {
    it('coerces native object literal values', async () => {
      const g = await loadAndResolve(outdent`
        # @type=record
        ITEM={k=v, n=2}
      `);
      expect(g.configSchema.ITEM.isValid).toBe(true);
      expect(g.configSchema.ITEM.resolvedValue).toEqual({ k: 'v', n: 2 });
    });

    it('parses JSON object strings', async () => {
      const g = await loadAndResolve(outdent`
        # @type=record
        ITEM='{"k": "v", "n": 2}'
      `);
      expect(g.configSchema.ITEM.isValid).toBe(true);
      expect(g.configSchema.ITEM.resolvedValue).toEqual({ k: 'v', n: 2 });
    });

    it('resolves refs within object literal values', async () => {
      const g = await loadAndResolve(outdent`
        BASE=https://example.com
        # @type=record(url)
        ENDPOINTS={api=\${BASE}, other=https://other.com}
      `);
      expect(g.configSchema.ENDPOINTS.isValid).toBe(true);
      expect(g.configSchema.ENDPOINTS.resolvedValue).toEqual({
        api: 'https://example.com',
        other: 'https://other.com',
      });
    });
  });

  describe('value validation', () => {
    it('validates every value with the value type', async () => {
      const g = await loadAndResolve(outdent`
        # @type=record(url)
        ITEM={good=https://example.com, bad=not-a-url}
      `);
      expect(g.configSchema.ITEM.isValid).toBe(false);
      expect(g.configSchema.ITEM.validationErrors?.[0]?.message).toContain('"bad"');
    });

    it('coerces values with the value type', async () => {
      const g = await loadAndResolve(outdent`
        # @type=record(number)
        LIMITS={low=1, high=100}
      `);
      expect(g.configSchema.LIMITS.isValid).toBe(true);
      expect(g.configSchema.LIMITS.resolvedValue).toEqual({ low: 1, high: 100 });
    });
  });

  describe('key validation', () => {
    it('validates keys against an enum', async () => {
      const g = await loadAndResolve(outdent`
        # @type=record(url, keyType=enum(us, eu))
        REGIONS={us=https://us.example.com, eu=https://eu.example.com}
      `);
      expect(g.configSchema.REGIONS.isValid).toBe(true);
    });

    it('rejects keys not in the enum', async () => {
      const g = await loadAndResolve(outdent`
        # @type=record(url, keyType=enum(us, eu))
        REGIONS={us=https://us.example.com, apac=https://apac.example.com}
      `);
      expect(g.configSchema.REGIONS.isValid).toBe(false);
      expect(g.configSchema.REGIONS.validationErrors?.[0]?.message).toContain('"apac"');
    });

    it('validates keys with a pattern via string type options', async () => {
      const g = await loadAndResolve(outdent`
        # @type=record(string, keyType=string(matches="[a-z]+"))
        ITEM={lower=ok, UPPER=bad}
      `);
      expect(g.configSchema.ITEM.isValid).toBe(false);
      expect(g.configSchema.ITEM.validationErrors?.[0]?.message).toContain('"UPPER"');
    });
  });

  describe('record options', () => {
    it('rejects unknown record options', async () => {
      const g = await loadAndResolve(outdent`
        # @type=record(string, whatever=true)
        ITEM={k=v}
      `);
      expect(g.configSchema.ITEM.isValid).toBe(false);
      expect(g.configSchema.ITEM.errors[0].message).toContain('whatever');
    });

    it('rejects empty objects by default', async () => {
      const g = await loadAndResolve(outdent`
        # @type=record(string)
        ITEM={}
      `);
      expect(g.configSchema.ITEM.isValid).toBe(false);
      const err = g.configSchema.ITEM.validationErrors?.[0];
      expect(err?.message).toContain('must not be empty');
      expect(err?.tip).toContain('entriesMinLength=0');
    });

    it('allows empty objects with explicit entriesMinLength=0', async () => {
      const g = await loadAndResolve(outdent`
        # @type=record(string, entriesMinLength=0)
        ITEM={}
      `);
      expect(g.configSchema.ITEM.isValid).toBe(true);
      expect(g.configSchema.ITEM.resolvedValue).toEqual({});
    });

    it('enforces entriesMinLength', async () => {
      const g = await loadAndResolve(outdent`
        # @type=record(string, entriesMinLength=2)
        ITEM={only=one}
      `);
      expect(g.configSchema.ITEM.isValid).toBe(false);
      expect(g.configSchema.ITEM.validationErrors?.[0]?.message).toContain('at least 2');
    });

    it('enforces entriesMaxLength', async () => {
      const g = await loadAndResolve(outdent`
        # @type=record(string, entriesMaxLength=1)
        ITEM={a=1, b=2}
      `);
      expect(g.configSchema.ITEM.isValid).toBe(false);
      expect(g.configSchema.ITEM.validationErrors?.[0]?.message).toContain('at most 1');
    });

    it('enforces entriesIsLength (exact entry count)', async () => {
      const good = await loadAndResolve(outdent`
        # @type=record(string, entriesIsLength=2)
        ITEM={a=1, b=2}
      `);
      expect(good.configSchema.ITEM.isValid).toBe(true);

      const bad = await loadAndResolve(outdent`
        # @type=record(string, entriesIsLength=2)
        ITEM={a=1}
      `);
      expect(bad.configSchema.ITEM.isValid).toBe(false);
      expect(bad.configSchema.ITEM.validationErrors?.[0]?.message).toContain('exactly 2');
    });

    it('entry count options support dynamic values', async () => {
      const g = await loadAndResolve(outdent`
        STRICT=true
        # @type=record(string, entriesMinLength=if($STRICT, 2, 0))
        ITEM={only=one}
      `);
      expect(g.configSchema.ITEM.isValid).toBe(false);
    });
  });

  describe('type inference', () => {
    it('infers object type from an untyped object literal', async () => {
      const g = await loadAndResolve(outdent`
        ITEM={k=v, n=2}
      `);
      expect(g.configSchema.ITEM.isValid).toBe(true);
      expect(g.configSchema.ITEM.dataType?.name).toBe('record');
      expect(g.configSchema.ITEM.resolvedValue).toEqual({ k: 'v', n: 2 });
    });
  });

  describe('nesting composites', () => {
    it('supports arrays of objects (forced JSON serialization)', async () => {
      const g = await loadAndResolve(outdent`
        # @type=array(record)
        ITEMS=[{name=a}, {name=b}]
      `);
      expect(g.configSchema.ITEMS.isValid).toBe(true);
      expect(g.configSchema.ITEMS.resolvedValue).toEqual([{ name: 'a' }, { name: 'b' }]);
    });

    it('supports objects of arrays', async () => {
      const g = await loadAndResolve(outdent`
        # @type=record(array(number))
        GROUPS={a=[1, 2], b=[3]}
      `);
      expect(g.configSchema.GROUPS.isValid).toBe(true);
      expect(g.configSchema.GROUPS.resolvedValue).toEqual({ a: [1, 2], b: [3] });
    });
  });
});

describe('@type arg handling (scalar types)', () => {
  it('rejects named options on enum', async () => {
    const g = await loadAndResolve(outdent`
      # @type=enum(a, b, someOpt=true)
      ITEM=a
    `);
    expect(g.configSchema.ITEM.isValid).toBe(false);
    expect(g.configSchema.ITEM.errors[0].message).toContain('does not take named options');
  });

  it('rejects unknown functions in option values with a clear error', async () => {
    const g = await loadAndResolve(outdent`
      # @type=string(matches=notAFunction(a, b))
      ITEM=x
    `);
    expect(g.configSchema.ITEM.isValid).toBe(false);
    expect(g.configSchema.ITEM.errors[0].message).toContain('not a static value or a known resolver function');
  });

  it('rejects nested type calls on scalar types', async () => {
    const g = await loadAndResolve(outdent`
      # @type=string(enum(a, b))
      ITEM=x
    `);
    expect(g.configSchema.ITEM.isValid).toBe(false);
    expect(g.configSchema.ITEM.errors[0].message).toContain('only supported as array/object element types');
  });

  it('still supports regex-like string patterns in options', async () => {
    const g = await loadAndResolve(outdent`
      # @type=string(matches=/^[A-Z]+$/)
      GOOD=ABC
      # @type=string(matches=/^[A-Z]+$/)
      BAD=abc
    `);
    expect(g.configSchema.GOOD.isValid).toBe(true);
    expect(g.configSchema.BAD.isValid).toBe(false);
  });
});

describe('dynamic @type parts (resolver-valued)', () => {
  describe('dynamic option values', () => {
    it('resolves option values via if() with refs to other items', async () => {
      const g = await loadAndResolve(outdent`
        # @type=enum(sandbox, production)
        APP_MODE=production
        # @type=array(email, minLength=if(eq($APP_MODE, production), 2, 0))
        ALLOWED_EMAILS=[only-one@example.com]
      `);
      expect(g.configSchema.ALLOWED_EMAILS.isValid).toBe(false);
      const messages = (g.configSchema.ALLOWED_EMAILS.validationErrors ?? []).map((e) => e.message).join('\n');
      expect(messages).toContain('at least 2');
    });

    it('dynamic option values pass when the resolved constraint is satisfied', async () => {
      const g = await loadAndResolve(outdent`
        # @type=enum(sandbox, production)
        APP_MODE=sandbox
        # @type=array(email, minLength=if(eq($APP_MODE, production), 2, 0))
        ALLOWED_EMAILS=[only-one@example.com]
      `);
      expect(g.configSchema.ALLOWED_EMAILS.isValid).toBe(true);
    });

    it('supports dynamic options on scalar types', async () => {
      const g = await loadAndResolve(outdent`
        STRICT=true
        # @type=string(minLength=if($STRICT, 10, 1))
        TOKEN=short
      `);
      expect(g.configSchema.TOKEN.isValid).toBe(false);
    });

    it('rejects dynamic options that would change the generated type', async () => {
      const g = await loadAndResolve(outdent`
        FLAG=true
        # @type=number(isInt=if($FLAG, true, false))
        VAL=1.5
      `);
      expect(g.configSchema.VAL.isValid).toBe(false);
      const messages = (g.configSchema.VAL.validationErrors ?? []).map((e) => e.message).join('\n');
      expect(messages).toContain('generate the same type');
    });
  });

  describe('dynamic whole types', () => {
    it('switches the type via if() when candidates generate the same type', async () => {
      const g = await loadAndResolve(outdent`
        # @type=enum(dev, production)
        APP_ENV=production
        # @type=if(eq($APP_ENV, production), url, string)
        SERVICE_HOST=not-a-url
      `);
      // in production the value must be a url
      expect(g.configSchema.SERVICE_HOST.isValid).toBe(false);
    });

    it('relaxes validation when the dynamic type resolves to the looser candidate', async () => {
      const g = await loadAndResolve(outdent`
        # @type=enum(dev, production)
        APP_ENV=dev
        # @type=if(eq($APP_ENV, production), url, string)
        SERVICE_HOST=not-a-url
      `);
      expect(g.configSchema.SERVICE_HOST.isValid).toBe(true);
    });

    it('keeps typegen deterministic - provisional type comes from static candidates', async () => {
      const g = await loadAndResolve(outdent`
        # @type=enum(dev, production)
        APP_ENV=production
        # @type=if(eq($APP_ENV, production), url, string)
        SERVICE_HOST=https://example.com
      `);
      // the provisional (typegen-facing) instance stays the first candidate regardless of env
      expect(g.configSchema.SERVICE_HOST.dataType?.name).toBe('url');
      expect(g.configSchema.SERVICE_HOST.effectiveDataType?.name).toBe('url');
      expect(g.configSchema.SERVICE_HOST.isValid).toBe(true);
    });

    it('rejects candidate types that generate different types at load time', async () => {
      const g = await loadAndResolve(outdent`
        FLAG=true
        # @type=if($FLAG, number, string)
        VAL=123
      `);
      expect(g.configSchema.VAL.isValid).toBe(false);
      expect(g.configSchema.VAL.errors[0].message).toContain('do not all generate the same type');
    });

    it('rejects an opaque dynamic type resolving to a non-string-generating type', async () => {
      const g = await loadAndResolve(outdent`
        TYPE_NAME=number
        # @type=fallback($TYPE_NAME, string)
        VAL=123
      `);
      // fallback($TYPE_NAME, string) resolves to "number", whose generated type (number)
      // differs from the provisional candidate (string) - rejected at resolution time
      expect(g.configSchema.VAL.isValid).toBe(false);
      const messages = (g.configSchema.VAL.validationErrors ?? []).map((e) => e.message).join('\n');
      expect(messages).toContain('does not generate the same type');
    });

    it('errors when the dynamic type resolves to an unknown type name', async () => {
      const g = await loadAndResolve(outdent`
        TYPE_NAME=not-a-real-type
        # @type=fallback($TYPE_NAME, string)
        VAL=x
      `);
      expect(g.configSchema.VAL.isValid).toBe(false);
      const messages = (g.configSchema.VAL.validationErrors ?? []).map((e) => e.message).join('\n');
      expect(messages).toContain('invalid data type');
    });
  });
});

describe('composite coercion error paths', () => {
  it('reports ALL invalid elements during coercion, not just the first', async () => {
    const g = await loadAndResolve(outdent`
      # @type=array(number)
      NUMS=[abc, 2, xyz]
    `);
    expect(g.configSchema.NUMS.isValid).toBe(false);
    const msg = g.configSchema.NUMS.coercionError?.message ?? '';
    expect(msg).toContain('[0]');
    expect(msg).toContain('[2]');
    expect(msg).not.toContain('[1]');
  });

  it('rejects a scalar non-string value for an array type', async () => {
    const g = await loadAndResolve(outdent`
      # @type=array(string)
      ITEM=123
    `);
    expect(g.configSchema.ITEM.isValid).toBe(false);
    expect(g.configSchema.ITEM.coercionError?.message).toContain('Cannot coerce');
  });

  it('rejects a scalar value for an object type', async () => {
    const g = await loadAndResolve(outdent`
      # @type=record(string)
      ITEM=123
    `);
    expect(g.configSchema.ITEM.isValid).toBe(false);
  });

  it('errors on malformed JSON object strings', async () => {
    const g = await loadAndResolve(outdent`
      # @type=record(string)
      ITEM='{"a": '
    `);
    expect(g.configSchema.ITEM.isValid).toBe(false);
    expect(g.configSchema.ITEM.coercionError?.message).toContain('JSON');
  });

  it('reports ALL invalid object values during coercion', async () => {
    const g = await loadAndResolve(outdent`
      # @type=record(number)
      LIMITS={a=x, b=2, c=y}
    `);
    expect(g.configSchema.LIMITS.isValid).toBe(false);
    const msg = g.configSchema.LIMITS.coercionError?.message ?? '';
    expect(msg).toContain('"a"');
    expect(msg).toContain('"c"');
    expect(msg).not.toContain('"b"');
  });

  it('empty/whitespace string input resolves to missing, never an empty array', async () => {
    const g = await loadAndResolve(outdent`
      # @type=array(string)
      WHITESPACE=" "
      # @type=array(string)
      QUOTED_EMPTY=""
    `);
    expect(g.configSchema.WHITESPACE.isValid).toBe(true);
    expect(g.configSchema.WHITESPACE.resolvedValue).toBe(undefined);
    expect(g.configSchema.QUOTED_EMPTY.isValid).toBe(true);
    expect(g.configSchema.QUOTED_EMPTY.resolvedValue).toBe(undefined);
  });

  it('required items reject empty/whitespace string input as missing', async () => {
    const g = await loadAndResolve(outdent`
      # @type=array(string)
      # @required
      ITEM=" "
    `);
    expect(g.configSchema.ITEM.isValid).toBe(false);
    expect(g.configSchema.ITEM.validationErrors?.[0]?.message).toContain('required but is currently empty');
  });

  it('required items accept an explicitly non-empty array', async () => {
    const g = await loadAndResolve(outdent`
      # @type=array(string)
      # @required
      ITEM=[a]
    `);
    expect(g.configSchema.ITEM.isValid).toBe(true);
  });
});

describe('@type option validation error paths', () => {
  const badSpecs = [
    ['array(string, separator=7)', 'separator must be a non-empty string'],
    ['array(string, separator="")', 'separator must be a non-empty string'],
    ['array(string, format=yaml)', 'format must be "separator" or "json"'],
    ['array(string, minLength=abc)', 'minLength must be a number'],
    ['array(string, isLength=abc)', 'isLength must be a number'],
    ['array(string, unique=maybe)', 'unique must be a boolean'],
    ['array(string, number)', 'single element type argument'],
    ['record(string, number)', 'single value type argument'],
    ['record(string, keyType={a=b})', 'keyType must be a type name or type call'],
    ['record(string, keys=enum(a, b))', 'unknown record option "keys"'],
    ['record(string, entriesMinLength=abc)', 'entriesMinLength must be a number'],
  ] as const;

  for (const [spec, expectedError] of badSpecs) {
    it(`rejects ${spec}`, async () => {
      const g = await loadAndResolve(outdent`
        # @type=${spec}
        ITEM=[a]
      `);
      expect(g.configSchema.ITEM.isValid).toBe(false);
      expect(g.configSchema.ITEM.errors[0].message).toContain(expectedError);
    });
  }

  it('points object users at record', async () => {
    const g = await loadAndResolve(outdent`
      # @type=object(url)
      ITEM={k=v}
    `);
    expect(g.configSchema.ITEM.isValid).toBe(false);
    expect(g.configSchema.ITEM.errors[0].message).toContain('unknown data type: object');
    expect(g.configSchema.ITEM.errors[0].tip).toContain('record(...)');
  });

  it('rejects a fn call that is neither a type nor a resolver', async () => {
    const g = await loadAndResolve(outdent`
      # @type=notARealThing(a, b)
      ITEM=x
    `);
    expect(g.configSchema.ITEM.isValid).toBe(false);
    expect(g.configSchema.ITEM.errors[0].message).toContain('unknown data type: notARealThing');
  });

  it('supports the deprecated regex() option form', async () => {
    const g = await loadAndResolve(outdent`
      # @type=string(matches=regex("^[A-Z]+$"))
      GOOD=ABC
      # @type=string(matches=regex("^[A-Z]+$"))
      BAD=abc
    `);
    expect(g.configSchema.GOOD.isValid).toBe(true);
    expect(g.configSchema.BAD.isValid).toBe(false);
  });

  it('surfaces schema errors from resolver-valued options (bad arg counts)', async () => {
    const g = await loadAndResolve(outdent`
      OTHER=x
      # @type=string(minLength=eq($OTHER))
      ITEM=abc
    `);
    expect(g.configSchema.ITEM.isValid).toBe(false);
    const messages = g.configSchema.ITEM.errors.map((e) => e.message).join('\n');
    expect(messages).toContain('eq()');
  });
});

describe('dynamic options within nested element types', () => {
  it('resolves dynamic options inside array element types', async () => {
    const g = await loadAndResolve(outdent`
      STRICT=true
      # @type=array(string(minLength=if($STRICT, 5, 1)))
      ITEMS=[ok, toolongisfine, x]
    `);
    expect(g.configSchema.ITEMS.isValid).toBe(false);
    const messages = (g.configSchema.ITEMS.validationErrors ?? []).map((e) => e.message).join('\n');
    expect(messages).toContain('[0]');
    expect(messages).toContain('[2]');
  });

  it('relaxes nested element constraints when the condition flips', async () => {
    const g = await loadAndResolve(outdent`
      STRICT=false
      # @type=array(string(minLength=if($STRICT, 5, 1)))
      ITEMS=[ok, toolongisfine, x]
    `);
    expect(g.configSchema.ITEMS.isValid).toBe(true);
  });
});

describe('per-environment dynamic types via forEnv', () => {
  async function loadWithEnv(appEnv: string) {
    const g = new EnvGraph();
    const testDataSource = new DotEnvFileDataSource('.env.schema', {
      overrideContents: outdent`
        # @currentEnv=$APP_ENV @defaultRequired=false
        # ---
        # @type=enum(dev, production)
        APP_ENV=${appEnv}
        # @type=string(minLength=if(forEnv(production), 10, 1))
        API_TOKEN=short
        # @type=if(forEnv(production), url, string)
        SERVICE_HOST=not a url
      `,
    });
    await g.setRootDataSource(testDataSource);
    await g.finishLoad();
    await g.resolveEnvValues();
    return g;
  }

  it('applies strict constraints in production', async () => {
    const g = await loadWithEnv('production');
    expect(g.configSchema.API_TOKEN.isValid).toBe(false);
    expect(g.configSchema.SERVICE_HOST.isValid).toBe(false);
  });

  it('relaxes constraints outside production', async () => {
    const g = await loadWithEnv('dev');
    expect(g.configSchema.API_TOKEN.isValid).toBe(true);
    expect(g.configSchema.SERVICE_HOST.isValid).toBe(true);
  });
});

describe('enum members sourced from other items', () => {
  it('validates against members spread from a referenced array item', async () => {
    const g = await loadAndResolve(outdent`
      # @type=array(string)
      ALLOWED_MODES=[dev, staging, prod]
      # @type=enum($ALLOWED_MODES)
      APP_MODE=staging
    `);
    expect(g.configSchema.APP_MODE.isValid).toBe(true);
    expect(g.configSchema.APP_MODE.resolvedValue).toBe('staging');
  });

  it('rejects values not in the referenced array', async () => {
    const g = await loadAndResolve(outdent`
      # @type=array(string)
      ALLOWED_MODES=[dev, staging, prod]
      # @type=enum($ALLOWED_MODES)
      APP_MODE=nope
    `);
    expect(g.configSchema.APP_MODE.isValid).toBe(false);
    const err = g.configSchema.APP_MODE.validationErrors?.[0];
    expect(err?.message).toContain('not in list of possible values');
    expect(err?.tip).toContain('dev');
  });

  it('supports mixing static members with referenced arrays', async () => {
    const g = await loadAndResolve(outdent`
      # @type=array(string)
      EXTRA_MODES=[staging, preview]
      # @type=enum(dev, $EXTRA_MODES, prod)
      APP_MODE=preview
    `);
    expect(g.configSchema.APP_MODE.isValid).toBe(true);
  });

  it('a scalar reference contributes a single member', async () => {
    const g = await loadAndResolve(outdent`
      DEFAULT_MODE=dev
      # @type=enum($DEFAULT_MODE, prod)
      APP_MODE=dev
    `);
    expect(g.configSchema.APP_MODE.isValid).toBe(true);
  });

  it('the provisional (typegen-facing) type is a plain string', async () => {
    const g = await loadAndResolve(outdent`
      # @type=array(string)
      ALLOWED_MODES=[dev, prod]
      # @type=enum($ALLOWED_MODES)
      APP_MODE=dev
    `);
    expect(g.configSchema.APP_MODE.dataType?.name).toBe('string');
    expect(g.configSchema.APP_MODE.effectiveDataType?.name).toBe('enum');
  });

  it('rejects non-string dynamic members (typegen saw string)', async () => {
    const g = await loadAndResolve(outdent`
      # @type=array(number)
      LEVELS=[1, 2, 3]
      # @type=enum($LEVELS)
      LEVEL=2
    `);
    expect(g.configSchema.LEVEL.isValid).toBe(false);
    const messages = (g.configSchema.LEVEL.validationErrors ?? []).map((e) => e.message).join('\n');
    expect(messages).toContain('must resolve to strings');
  });

  it('rejects an empty resolved member list', async () => {
    const g = await loadAndResolve(outdent`
      # @type=array(string, minLength=0)
      ALLOWED_MODES=[]
      # @type=enum($ALLOWED_MODES)
      APP_MODE=dev
    `);
    expect(g.configSchema.APP_MODE.isValid).toBe(false);
    const messages = (g.configSchema.APP_MODE.validationErrors ?? []).map((e) => e.message).join('\n');
    expect(messages).toContain('empty list');
  });

  it('works as an array element type (array(enum($MODES)))', async () => {
    const g = await loadAndResolve(outdent`
      # @type=array(string)
      ALLOWED_MODES=[dev, staging, prod]
      # @type=array(enum($ALLOWED_MODES))
      ACTIVE_MODES=[dev, prod]
      # @type=array(enum($ALLOWED_MODES))
      BAD_MODES=[dev, nope]
    `);
    expect(g.configSchema.ACTIVE_MODES.isValid).toBe(true);
    expect(g.configSchema.ACTIVE_MODES.resolvedValue).toEqual(['dev', 'prod']);
    expect(g.configSchema.BAD_MODES.isValid).toBe(false);
    expect(g.configSchema.BAD_MODES.validationErrors?.[0]?.message).toContain('[1]');
  });
});

describe('multi-line composite literal values', () => {
  it('resolves multi-line array literals (trailing comma, comments, blank lines)', async () => {
    const g = await loadAndResolve(outdent`
      # @type=array(email)
      ALLOWED_EMAILS=[
        admin@example.com, # the boss
        # ops folks
        ops@example.com,

        support@example.com,
      ]
      AFTER=still-parses
    `);
    expect(g.configSchema.ALLOWED_EMAILS.isValid).toBe(true);
    expect(g.configSchema.ALLOWED_EMAILS.resolvedValue).toEqual([
      'admin@example.com',
      'ops@example.com',
      'support@example.com',
    ]);
    expect(g.configSchema.AFTER.resolvedValue).toBe('still-parses');
  });

  it('resolves multi-line record literals with refs', async () => {
    const g = await loadAndResolve(outdent`
      BASE=https://api.example.com
      # @type=record(url)
      ENDPOINTS={
        api=${'$'}{BASE},
        docs=https://docs.example.com,
      }
    `);
    expect(g.configSchema.ENDPOINTS.isValid).toBe(true);
    expect(g.configSchema.ENDPOINTS.resolvedValue).toEqual({
      api: 'https://api.example.com',
      docs: 'https://docs.example.com',
    });
  });

  it('resolves multi-line arrays of records', async () => {
    const g = await loadAndResolve(outdent`
      # @type=array(record)
      ITEMS=[
        {name=a, weight=1},
        {name=b, weight=2},
      ]
    `);
    expect(g.configSchema.ITEMS.isValid).toBe(true);
    expect(g.configSchema.ITEMS.resolvedValue).toEqual([
      { name: 'a', weight: 1 },
      { name: 'b', weight: 2 },
    ]);
  });
});
