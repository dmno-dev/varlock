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
    it('allows empty arrays by default', async () => {
      const g = await loadAndResolve(outdent`
        # @type=array(string)
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

describe('object data type', () => {
  describe('input forms', () => {
    it('coerces native object literal values', async () => {
      const g = await loadAndResolve(outdent`
        # @type=object
        ITEM={k=v, n=2}
      `);
      expect(g.configSchema.ITEM.isValid).toBe(true);
      expect(g.configSchema.ITEM.resolvedValue).toEqual({ k: 'v', n: 2 });
    });

    it('parses JSON object strings', async () => {
      const g = await loadAndResolve(outdent`
        # @type=object
        ITEM='{"k": "v", "n": 2}'
      `);
      expect(g.configSchema.ITEM.isValid).toBe(true);
      expect(g.configSchema.ITEM.resolvedValue).toEqual({ k: 'v', n: 2 });
    });

    it('resolves refs within object literal values', async () => {
      const g = await loadAndResolve(outdent`
        BASE=https://example.com
        # @type=object(url)
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
        # @type=object(url)
        ITEM={good=https://example.com, bad=not-a-url}
      `);
      expect(g.configSchema.ITEM.isValid).toBe(false);
      expect(g.configSchema.ITEM.validationErrors?.[0]?.message).toContain('"bad"');
    });

    it('coerces values with the value type', async () => {
      const g = await loadAndResolve(outdent`
        # @type=object(number)
        LIMITS={low=1, high=100}
      `);
      expect(g.configSchema.LIMITS.isValid).toBe(true);
      expect(g.configSchema.LIMITS.resolvedValue).toEqual({ low: 1, high: 100 });
    });
  });

  describe('key validation', () => {
    it('validates keys against an enum', async () => {
      const g = await loadAndResolve(outdent`
        # @type=object(url, keys=enum(us, eu))
        REGIONS={us=https://us.example.com, eu=https://eu.example.com}
      `);
      expect(g.configSchema.REGIONS.isValid).toBe(true);
    });

    it('rejects keys not in the enum', async () => {
      const g = await loadAndResolve(outdent`
        # @type=object(url, keys=enum(us, eu))
        REGIONS={us=https://us.example.com, apac=https://apac.example.com}
      `);
      expect(g.configSchema.REGIONS.isValid).toBe(false);
      expect(g.configSchema.REGIONS.validationErrors?.[0]?.message).toContain('"apac"');
    });

    it('validates keys with a pattern via string type options', async () => {
      const g = await loadAndResolve(outdent`
        # @type=object(string, keys=string(matches="[a-z]+"))
        ITEM={lower=ok, UPPER=bad}
      `);
      expect(g.configSchema.ITEM.isValid).toBe(false);
      expect(g.configSchema.ITEM.validationErrors?.[0]?.message).toContain('"UPPER"');
    });
  });

  describe('object options', () => {
    it('rejects unknown object options', async () => {
      const g = await loadAndResolve(outdent`
        # @type=object(string, whatever=true)
        ITEM={k=v}
      `);
      expect(g.configSchema.ITEM.isValid).toBe(false);
      expect(g.configSchema.ITEM.errors[0].message).toContain('whatever');
    });

    it('allows empty objects', async () => {
      const g = await loadAndResolve(outdent`
        # @type=object(string)
        ITEM={}
      `);
      expect(g.configSchema.ITEM.isValid).toBe(true);
      expect(g.configSchema.ITEM.resolvedValue).toEqual({});
    });
  });

  describe('type inference', () => {
    it('infers object type from an untyped object literal', async () => {
      const g = await loadAndResolve(outdent`
        ITEM={k=v, n=2}
      `);
      expect(g.configSchema.ITEM.isValid).toBe(true);
      expect(g.configSchema.ITEM.dataType?.name).toBe('object');
      expect(g.configSchema.ITEM.resolvedValue).toEqual({ k: 'v', n: 2 });
    });
  });

  describe('nesting composites', () => {
    it('supports arrays of objects (forced JSON serialization)', async () => {
      const g = await loadAndResolve(outdent`
        # @type=array(object)
        ITEMS=[{name=a}, {name=b}]
      `);
      expect(g.configSchema.ITEMS.isValid).toBe(true);
      expect(g.configSchema.ITEMS.resolvedValue).toEqual([{ name: 'a' }, { name: 'b' }]);
    });

    it('supports objects of arrays', async () => {
      const g = await loadAndResolve(outdent`
        # @type=object(array(number))
        GROUPS={a=[1, 2], b=[3]}
      `);
      expect(g.configSchema.GROUPS.isValid).toBe(true);
      expect(g.configSchema.GROUPS.resolvedValue).toEqual({ a: [1, 2], b: [3] });
    });
  });
});

describe('@type arg handling (scalar types)', () => {
  it('rejects mixing positional args and named options', async () => {
    const g = await loadAndResolve(outdent`
      # @type=enum(a, b, someOpt=true)
      ITEM=a
    `);
    expect(g.configSchema.ITEM.isValid).toBe(false);
    expect(g.configSchema.ITEM.errors[0].message).toContain('cannot mix');
  });

  it('rejects non-static option values with a clear error', async () => {
    const g = await loadAndResolve(outdent`
      # @type=string(matches=fallback(a, b))
      ITEM=x
    `);
    expect(g.configSchema.ITEM.isValid).toBe(false);
    expect(g.configSchema.ITEM.errors[0].message).toContain('must be a static value');
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
