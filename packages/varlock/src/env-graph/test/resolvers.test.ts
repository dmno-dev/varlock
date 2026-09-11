/*
  Test our resolvers functions

  Note that @env-spec/parser tests the mechanics of the parsing
  so here we mostly just need to test the translation from parser to resolvers
  and that the resolvers are working as expected
*/


import { describe, it, expect } from 'vitest';
import { outdent } from 'outdent';
import { DotEnvFileDataSource, EnvGraph } from '../index';
import { ResolutionError, SchemaError } from '../lib/errors';
import { Resolver } from '../lib/resolver';
import type { Constructor } from '@env-spec/utils/type-utils';

// define special increment resolver used only for tests
class IncrementResolver extends Resolver {
  static def = {
    name: 'increment',
    label: 'increment',
    icon: '',
    resolve() { return ''; },
  };
  static counter = 0;
  async resolve() { return ++IncrementResolver.counter; }
}

function functionValueTests(
  tests: Record<string, {
    input: string;
    expected: Record<string, string | number | boolean | undefined | Constructor<Error>>;
    /** if true, expects items to have only warnings (not full errors) while still resolving */
    expectWarnings?: boolean;
  }>,
) {
  return () => {
    Object.entries(tests).forEach(([label, spec]) => {
      const { input, expected, expectWarnings } = spec;
      it(label, async () => {
        const g = new EnvGraph();


        // reset the increment counter for each test
        IncrementResolver.counter = 0;
        g.registerResolver(IncrementResolver);

        const testDataSource = new DotEnvFileDataSource('.env.schema', {
          overrideContents: outdent`
            # @defaultRequired=false
            # these fixtures exercise resolver mechanics, not secrets - and their throwaway
            # values are short enough to trip the short-sensitive-value check
            # @defaultSensitive=false
            # ---
            ${input}
          `,
        });
        await g.setRootDataSource(testDataSource);
        await g.finishLoad();

        await g.resolveEnvValues();
        for (const key in expected) {
          const item = g.configSchema[key];
          const expectedValue = expected[key];
          if (expectedValue === SchemaError) {
            expect(item.errors.length).toBeGreaterThan(0);
            expect(item.errors[0]).toBeInstanceOf(SchemaError);
          } else if (expectedValue === ResolutionError) {
            expect(item.resolutionError).toBeInstanceOf(ResolutionError);
          } else {
            if (expectWarnings) {
              // item should have warnings only (not hard errors), and still resolve
              expect(item.validationState, `Expected item ${key} to have warnings, not errors`).not.toBe('error');
            } else {
              expect(item.isValid, `Expected item ${key} to be valid`).toBeTruthy();
            }
            const normalizedResolvedValue = typeof item.resolvedValue === 'string'
              ? item.resolvedValue.replaceAll('\r', '')
              : item.resolvedValue;
            expect(normalizedResolvedValue).toEqual(expectedValue);
          }
        }
      });
    });
  };
}


describe('concat()', functionValueTests({
  'working example': {
    input: 'ITEM=concat("a", "", b, undefined, `c`)',
    expected: { ITEM: 'abc' },
  },
  'error - no args': {
    input: 'ITEM=concat()',
    expected: { ITEM: SchemaError },
  },
  'error - single arg': {
    input: 'ITEM=concat(a)',
    expected: { ITEM: SchemaError },
  },
  'error - key/val args': {
    input: 'ITEM=concat(a=b, c=d)',
    expected: { ITEM: SchemaError },
  },
}));

describe('fallback()', functionValueTests({
  'working example': {
    input: 'ITEM=fallback("", undefined, first, second)',
    expected: { ITEM: 'first' },
  },
  'error - no args': {
    input: 'ITEM=fallback()',
    expected: { ITEM: SchemaError },
  },
  'error - single arg': {
    input: 'ITEM=fallback(a)',
    expected: { ITEM: SchemaError },
  },
  'error - key/val args': {
    input: 'ITEM=fallback(a=b, c=d)',
    expected: { ITEM: SchemaError },
  },
  'triggers error if invalid arg is evaluated': {
    input: 'ITEM=fallback(ref(BADKEY), "foo")',
    expected: { ITEM: SchemaError },
  },
  // ! we may want to change this in the future
  // and instead allow a resolver to attempt to resolve until it hits an invalid child
  'still triggers error if invalid arg will not actually be evaluated': {
    input: 'ITEM=fallback("foo", ref(BADKEY))',
    expected: { ITEM: SchemaError },
  },
}));

describe('exec()', functionValueTests({
  'working example': {
    input: 'ITEM=exec("echo moo")',
    expected: { ITEM: 'moo' },
  },
  'error - no command': {
    input: 'ITEM=exec()',
    expected: { ITEM: SchemaError },
  },
  'error - key/val args': {
    input: 'ITEM=exec(cmd="echo moo")',
    expected: { ITEM: SchemaError },
  },
}));


describe('ref()', functionValueTests({
  'working example': {
    input: outdent`
      OTHER=otherval
      ITEM=ref(OTHER)
    `,
    expected: { ITEM: 'otherval' },
  },
  'working example with $ expansion': {
    input: outdent`
      A=a-val
      B=$A
    `,
    expected: { A: 'a-val', B: 'a-val' },
  },
  // this applies to all dependencies, not just `ref()`
  'dependent items are allowed to be defined out of order': {
    input: outdent`
      B=$A
      A=a-val
    `,
    expected: { A: 'a-val', B: 'a-val' },
  },

  // this increment resolver is used in the next test
  // it just increments a global counter each time it is resolved
  'check increment() resolver is working properly': {
    input: 'ITEM=concat(increment(), increment(), increment())',
    expected: { ITEM: '123' },
  },
  'multiple dependencies dont trigger multiple resolutions': {
    input: outdent`
      A=a
      B=b
      C=c
      ITEM=concat("$A$B$C", increment())
    `,
    expected: { ITEM: 'abc1' }, // would be 'abc3' if it resolved for each dependency
  },
  'error - no key': {
    input: 'ITEM=ref()',
    expected: { ITEM: SchemaError },
  },
  'error - not string key': {
    input: 'ITEM=ref(123)',
    expected: { ITEM: SchemaError },
  },
  'error - not-existant key': {
    input: outdent`
      OTHER=otherval
      ITEM=ref(BADKEY)
    `,
    expected: { ITEM: SchemaError },
  },
  'error - non-static key': {
    input: outdent`
      OTHER=otherval
      REFKEY=OTHER
      ITEM=ref(ref(REFKEY))
    `,
    expected: { ITEM: SchemaError },
  },
  'error - key/val args': {
    input: outdent`
      OTHER=otherval
      ITEM=ref(key=OTHER)
    `,
    expected: { ITEM: SchemaError },
  },
}));

describe('ref() unresolved dependency guard', () => {
  it('errors loudly if resolved before its dependency (instead of silently returning undefined)', async () => {
    const g = new EnvGraph();
    const testDataSource = new DotEnvFileDataSource('.env.schema', {
      overrideContents: outdent`
        # @defaultRequired=false
        # ---
        OTHER=otherval
        ITEM=ref(OTHER)
      `,
    });
    await g.setRootDataSource(testDataSource);
    await g.finishLoad();
    // simulate a buggy calling context that resolves ITEM without resolving its deps first
    await g.configSchema.ITEM.resolve();
    expect(g.configSchema.ITEM.resolutionError?.message).toContain('has not been resolved yet');
  });
});

describe('regex()', functionValueTests({
  'error - regex used as value': {
    input: 'ITEM=regex(.*)',
    expected: { ITEM: ResolutionError },
  },
  'regex-like string used as value is just a string': {
    input: 'ITEM=/^foo.*/',
    expected: { ITEM: '/^foo.*/' },
  },
  'path with slashes used as value is just a string': {
    input: 'ITEM=/folder/foo/bar',
    expected: { ITEM: '/folder/foo/bar' },
  },
  'quoted path with slashes used as value': {
    input: 'ITEM="/usr/local/bin/"',
    expected: { ITEM: '/usr/local/bin/' },
  },
  'error - invalid regex': {
    input: outdent`
      OTHER=other
      ITEM=remap($OTHER, regex("("), bad, foo, default)
    `,
    expected: { ITEM: SchemaError },
  },
  'error - invalid regex (legacy syntax)': {
    input: outdent`
      OTHER=other
      ITEM=remap($OTHER, bad=regex("("), default)
    `,
    expected: { ITEM: SchemaError },
  },
  // functionality is checked below within remap() tests
}));

describe('remap()', functionValueTests({
  'keeps original value if no match found': {
    input: outdent`
      REMAP_ME=foo
      ITEM=remap($REMAP_ME, b, a, c, b)
    `,
    expected: { ITEM: 'foo' },
  },
  'remaps exact match': {
    input: outdent`
      REMAP_ME=foo
      ITEM=remap($REMAP_ME, buz, biz, foo, bar)
    `,
    expected: { ITEM: 'bar' },
  },
  'remaps regex match': {
    input: outdent`
      REMAP_ME=foo
      ITEM=remap($REMAP_ME, buz, biz, regex(fo+), bar)
    `,
    expected: { ITEM: 'bar' },
  },
  'remaps regex literal match': {
    input: outdent`
      REMAP_ME=foo
      ITEM=remap($REMAP_ME, buz, biz, /fo+/, bar)
    `,
    expected: { ITEM: 'bar' },
  },
  'remaps regex literal with flags': {
    input: outdent`
      REMAP_ME=FOO
      ITEM=remap($REMAP_ME, buz, biz, /foo/i, bar)
    `,
    expected: { ITEM: 'bar' },
  },
  'path-like string in remap is exact match not regex': {
    input: outdent`
      REMAP_ME=/usr/local
      ITEM=remap($REMAP_ME, /usr/local, found, default)
    `,
    expected: { ITEM: 'found' },
  },
  'quoted path in remap is exact match': {
    input: outdent`
      REMAP_ME=/some/path
      ITEM=remap($REMAP_ME, "/some/path", found, default)
    `,
    expected: { ITEM: 'found' },
  },
  'remaps undefined match': {
    input: outdent`
      REMAP_ME=
      ITEM=remap($REMAP_ME, buz, biz, undefined, bar)
    `,
    expected: { REMAP_ME: undefined, ITEM: 'bar' },
  },
  'uses default when no match': {
    input: outdent`
      REMAP_ME=unknown
      ITEM=remap($REMAP_ME, foo, a, bar, b, default-val)
    `,
    expected: { ITEM: 'default-val' },
  },
  // legacy key=value syntax (deprecated but still supported - emits a deprecation warning)
  'legacy key=val: keeps original value if no match found': {
    input: outdent`
      REMAP_ME=foo
      ITEM=remap($REMAP_ME, a=b, b=c)
    `,
    expected: { ITEM: 'foo' },
    expectWarnings: true,
  },
  'legacy key=val: remaps exact match': {
    input: outdent`
      REMAP_ME=foo
      ITEM=remap($REMAP_ME, biz=buz, bar=foo)
    `,
    expected: { ITEM: 'bar' },
    expectWarnings: true,
  },
  'legacy key=val: remaps regex match': {
    input: outdent`
      REMAP_ME=foo
      ITEM=remap($REMAP_ME, biz=buz, bar=regex(fo+))
    `,
    expected: { ITEM: 'bar' },
    expectWarnings: true,
  },
  'legacy key=val: remaps undefined match': {
    input: outdent`
      REMAP_ME=
      ITEM=remap($REMAP_ME, biz=buz, bar=undefined)
    `,
    expected: { REMAP_ME: undefined, ITEM: 'bar' },
    expectWarnings: true,
  },
  'error - no args': {
    input: 'ITEM=remap()',
    expected: { ITEM: SchemaError },
  },
  'error - too few args': {
    input: 'ITEM=remap("value")',
    expected: { ITEM: SchemaError },
  },
  'error - too few args (2 positional)': {
    input: 'ITEM=remap("value", "match")',
    expected: { ITEM: SchemaError },
  },
}));

describe('eq()', functionValueTests({
  'check equality': {
    input: outdent`
      STR=eq("a", "a")
      NUM=eq(42, 42)
      BOOL=eq(false, false)
      UNDEF=eq(undefined, undefined)
    `,
    expected: {
      STR: true,
      NUM: true,
      BOOL: true,
      UNDEF: true,
    },
  },
  'check inequality': {
    input: outdent`
      STR=eq("a", "b")
      NUM=eq(42, 41)
      BOOL=eq(true, false)
      MIXED=eq(42, "42")
    `,
    expected: {
      STR: false,
      NUM: false,
      BOOL: false,
      MIXED: false,
    },
  },
  'with variables': {
    input: outdent`
      A=test
      B=test
      C=different
      ITEM1=eq($A, $B)
      ITEM2=eq($A, $C)
    `,
    expected: { ITEM1: true, ITEM2: false },
  },
  'with nested resolvers': {
    input: 'ITEM=eq(concat("a", "b"), "ab")',
    expected: { ITEM: true },
  },
  'working example - undefined values': {
    input: outdent`
      A=
      B=
      ITEM=eq($A, $B)
    `,
    expected: { A: undefined, B: undefined, ITEM: true },
  },
  'error - no args': {
    input: 'ITEM=eq()',
    expected: { ITEM: SchemaError },
  },
  'error - single arg': {
    input: 'ITEM=eq("a")',
    expected: { ITEM: SchemaError },
  },
  'error - too many args': {
    input: 'ITEM=eq("a", "b", "c")',
    expected: { ITEM: SchemaError },
  },
  'error - key/val args': {
    input: 'ITEM=eq(left="a", right="b")',
    expected: { ITEM: SchemaError },
  },
}));

describe('if()', functionValueTests({
  'working examples': {
    input: outdent`
      TRUE=if(true, yes, no)
      FALSE=if(false, yes, no)
      STR=if("a", yes, no)
      NUM=if(1, yes, no)
      NUM0=if(0, yes, no)
    `,
    expected: {
      TRUE: 'yes',
      FALSE: 'no',
      STR: 'yes',
      NUM: 'yes',
      NUM0: 'no',
    },
  },
  'with nested fns': {
    input: outdent`
      ITEM1=if(eq(a, a), if(true, yes), no)
      ITEM2=if(eq(a, b), yes, if(true, no))
    `,
    expected: {
      ITEM1: 'yes',
      ITEM2: 'no',
    },
  },
  'no true/false values will coerce to boolean': {
    input: outdent`
      T1=if(hello)
      T2=if(true)
      T3=if(123)
      F1=if(undefined)
      F2=if("")
      F3=if(false)
      F4=if(0)
    `,
    expected: {
      T1: true, T2: true, T3: true, F1: false, F2: false, F3: false, F4: false,
    },
  },
  'optional false value will use undefined': {
    input: outdent`
      ITEM1=if(true, "yes")
      ITEM2=if(false, "yes")
    `,
    expected: { ITEM1: 'yes', ITEM2: undefined },
  },
  'error - no args': {
    input: 'ITEM=if()',
    expected: { ITEM: SchemaError },
  },
  'error - key/val args': {
    input: 'ITEM=if(condition=true, trueVal="yes", falseVal="no")',
    expected: { ITEM: SchemaError },
  },
  'error - nested bad arg': {
    input: 'ITEM=if(ref(BADKEY), "yes", "no")',
    expected: { ITEM: SchemaError },
  },
}));

describe('ifs()', functionValueTests({
  'returns value for first truthy condition': {
    input: outdent`
      ITEM=ifs(false, first, true, second, third)
    `,
    expected: { ITEM: 'second' },
  },
  'returns default when no condition matches': {
    input: outdent`
      ITEM=ifs(false, first, false, second, default-val)
    `,
    expected: { ITEM: 'default-val' },
  },
  'returns undefined when no match and no default': {
    input: outdent`
      ITEM=ifs(false, first, false, second)
    `,
    expected: { ITEM: undefined },
  },
  'with nested eq() conditions': {
    input: outdent`
      ENV=dev
      ITEM=ifs(eq($ENV, prod), prod-url, eq($ENV, staging), staging-url, dev-url)
    `,
    expected: { ITEM: 'dev-url' },
  },
  'with eq() matching first condition': {
    input: outdent`
      ENV=prod
      ITEM=ifs(eq($ENV, prod), prod-url, eq($ENV, staging), staging-url, dev-url)
    `,
    expected: { ITEM: 'prod-url' },
  },
  'single condition as default': {
    input: outdent`
      ITEM=ifs(eq("a", "b"), first, eq("b", "c"), second, default-val)
    `,
    expected: { ITEM: 'default-val' },
  },
  'error - no args': {
    input: 'ITEM=ifs()',
    expected: { ITEM: SchemaError },
  },
  'error - key/val args': {
    input: 'ITEM=ifs(condition=true, val="yes")',
    expected: { ITEM: SchemaError },
  },
}));

describe('not()', functionValueTests({
  'working - falsy values': {
    input: outdent`
      FALSE=not(false)
      EMPTY_STR=not("")
      ZERO=not(0)
      UNDEF=not(undefined)
    `,
    expected: {
      FALSE: true,
      EMPTY_STR: true,
      ZERO: true,
      UNDEF: true,
    },
  },
  'with truthy values': {
    input: outdent`
      STR=not("hello")
      NUM=not(42)
      BOOL=not(true)
    `,
    expected: {
      STR: false,
      NUM: false,
      BOOL: false,
    },
  },
  'with nested resolvers': {
    input: outdent`
      ITEM1=not(eq("a", "a"))
      ITEM2=not(eq("a", "b"))
    `,
    expected: { ITEM1: false, ITEM2: true },
  },
  'error - no args': {
    input: 'ITEM=not()',
    expected: { ITEM: SchemaError },
  },
  'error - too many args': {
    input: 'ITEM=not(true, false)',
    expected: { ITEM: SchemaError },
  },
  'error - key/val args': {
    input: 'ITEM=not(value=true)',
    expected: { ITEM: SchemaError },
  },
  'error - nested bad arg': {
    input: 'ITEM=not(ref(BADKEY))',
    expected: { ITEM: SchemaError },
  },
}));

describe('isEmpty()', functionValueTests({
  working: {
    input: outdent`
      UNDEF=isEmpty(undefined)
      EMPTY_STR=isEmpty("")
      STR=isEmpty(foo)
      ZERO=isEmpty(0)
      NUM=isEmpty(1)
      FALSE=isEmpty(false)
    `,
    expected: {
      UNDEF: true,
      EMPTY_STR: true,
      STR: false,
      ZERO: false,
      NUM: false,
      FALSE: false,
    },
  },
  'with nested resolvers': {
    input: outdent`
      ITEM1=isEmpty(concat("", ""))
      ITEM2=isEmpty(concat("a", "b"))
      ITEM3=isEmpty(if(true, undefined))
    `,
    expected: { ITEM1: true, ITEM2: false, ITEM3: true },
  },
  'error - no args': {
    input: 'ITEM=isEmpty()',
    expected: { ITEM: SchemaError },
  },
  'error - too many args': {
    input: 'ITEM=isEmpty("", "test")',
    expected: { ITEM: SchemaError },
  },
  'error - key/val args': {
    input: 'ITEM=isEmpty(value="")',
    expected: { ITEM: SchemaError },
  },
  'error - nested bad arg': {
    input: 'ITEM=isEmpty(ref(BADKEY))',
    expected: { ITEM: SchemaError },
  },
}));

describe('domainFromUrl()', functionValueTests({
  working: {
    input: outdent`
      FULL_URL=domainFromUrl("https://api.example.com/v1/users?id=1#top")
      WITH_PORT=domainFromUrl("https://example.com:8443/path")
      MIXED_CASE=domainFromUrl("https://Example.COM")
      BARE_HOST=domainFromUrl("example.com")
      BARE_HOST_WITH_PORT=domainFromUrl("example.com:8080/path")
      IPV4=domainFromUrl("http://127.0.0.1:3000/")
      IPV6=domainFromUrl("http://[::1]:3000/")
      IDN=domainFromUrl("https://bücher.example/")
      EMPTY=domainFromUrl("")
      UNDEF=domainFromUrl(undefined)
    `,
    expected: {
      FULL_URL: 'api.example.com',
      WITH_PORT: 'example.com',
      MIXED_CASE: 'example.com',
      BARE_HOST: 'example.com',
      BARE_HOST_WITH_PORT: 'example.com',
      IPV4: '127.0.0.1',
      IPV6: '[::1]',
      IDN: 'xn--bcher-kva.example',
      EMPTY: undefined,
      UNDEF: undefined,
    },
  },
  'resolves the host a request would actually use': {
    input: outdent`
      CREDENTIALS=domainFromUrl("https://trusted.example@evil.example/")
      BACKSLASH=domainFromUrl("https://evil.example\\@trusted.example/")
    `,
    expected: {
      CREDENTIALS: 'evil.example',
      BACKSLASH: 'evil.example',
    },
  },
  'with nested resolvers': {
    input: outdent`
      API_URL=https://api.example.com/v1
      API_DOMAIN=domainFromUrl($API_URL)
      COOKIE_DOMAIN=domainFromUrl(fallback(undefined, "https://www.example.com"))
    `,
    expected: {
      API_URL: 'https://api.example.com/v1',
      API_DOMAIN: 'api.example.com',
      COOKIE_DOMAIN: 'www.example.com',
    },
  },
  'hosts an explicit domain type would reject without settings': {
    // the inferred type is instantiated with allowSingleLabel/allowIp/allowIpV6, since the
    // input is any url - these all resolve rather than failing validation
    input: outdent`
      LOCAL=domainFromUrl("http://localhost:3000")
      IPV4=domainFromUrl("http://127.0.0.1:3000")
      IPV6=domainFromUrl("http://[::1]:3000")
    `,
    expected: {
      LOCAL: 'localhost',
      IPV4: '127.0.0.1',
      IPV6: '[::1]',
    },
  },
  'trailing root dot is dropped': {
    // `example.com.` names the same host, and the dot would fail every hostname check
    input: 'ITEM=domainFromUrl("https://example.com./path")',
    expected: { ITEM: 'example.com' },
  },
  'registrable=true narrows to the registrable domain': {
    input: outdent`
      SUBDOMAIN=domainFromUrl("https://api.example.com/v1", registrable=true)
      DEEP=domainFromUrl("https://a.b.c.example.com", registrable=true)
      MULTI_PART_TLD=domainFromUrl("https://app.example.co.uk", registrable=true)
      ALREADY_BARE=domainFromUrl("https://example.com", registrable=true)
      # private suffixes count, so this does not collapse to github.io
      PRIVATE_SUFFIX=domainFromUrl("https://foo.github.io", registrable=true)
      # hosts with no registrable domain are passed through unchanged
      LOCALHOST=domainFromUrl("http://localhost:3000", registrable=true)
      INTERNAL_NAME=domainFromUrl("http://db-primary:5432", registrable=true)
      IPV4=domainFromUrl("http://127.0.0.1:3000", registrable=true)
      IPV6=domainFromUrl("http://[::1]:3000", registrable=true)
      OFF_BY_DEFAULT=domainFromUrl("https://api.example.com")
    `,
    expected: {
      SUBDOMAIN: 'example.com',
      DEEP: 'example.com',
      MULTI_PART_TLD: 'example.co.uk',
      ALREADY_BARE: 'example.com',
      PRIVATE_SUFFIX: 'foo.github.io',
      LOCALHOST: 'localhost',
      INTERNAL_NAME: 'db-primary',
      IPV4: '127.0.0.1',
      IPV6: '[::1]',
      OFF_BY_DEFAULT: 'api.example.com',
    },
  },
  'error - registrable=true on a bare public suffix': {
    input: outdent`
      MULTI_LABEL=domainFromUrl("https://co.uk", registrable=true)
      # a single-label suffix is a suffix too, even though it looks like an internal name
      SINGLE_LABEL=domainFromUrl("https://com", registrable=true)
      PRIVATE_SUFFIX=domainFromUrl("https://github.io", registrable=true)
    `,
    expected: {
      MULTI_LABEL: ResolutionError,
      SINGLE_LABEL: ResolutionError,
      PRIVATE_SUFFIX: ResolutionError,
    },
  },
  'error - registrable is not static': {
    input: 'ITEM=domainFromUrl("https://api.example.com", registrable=concat("tr", "ue"))',
    expected: { ITEM: SchemaError },
  },
  'error - unknown option': {
    input: 'ITEM=domainFromUrl("https://api.example.com", dropSubdomains=true)',
    expected: { ITEM: SchemaError },
  },
  'error - not a url': {
    input: 'ITEM=domainFromUrl("not a url")',
    expected: { ITEM: ResolutionError },
  },
  'error - no host in url': {
    input: 'ITEM=domainFromUrl("mailto:someone@example.com")',
    expected: { ITEM: ResolutionError },
  },
  'error - no args': {
    input: 'ITEM=domainFromUrl()',
    expected: { ITEM: SchemaError },
  },
  'error - too many args': {
    input: 'ITEM=domainFromUrl("https://example.com", "extra")',
    expected: { ITEM: SchemaError },
  },
  'error - key/val args': {
    input: 'ITEM=domainFromUrl(url="https://example.com")',
    expected: { ITEM: SchemaError },
  },
  'error - nested bad arg': {
    input: 'ITEM=domainFromUrl(ref(BADKEY))',
    expected: { ITEM: SchemaError },
  },
}));

describe('domainFromUrl() through type-forwarding resolvers', functionValueTests({
  // if() and cache() pass a child's inferred type up to the item, so they have to pass the
  // type's settings along with it - otherwise these fail validation under a stricter `domain`
  working: {
    input: outdent`
      VIA_IF=if(true, domainFromUrl("http://127.0.0.1:3000"))
      VIA_CACHE=cache(domainFromUrl("http://localhost:3000"))
    `,
    expected: { VIA_IF: '127.0.0.1', VIA_CACHE: 'localhost' },
  },
}));

describe('domainFromUrl() type inference', () => {
  it('infers the domain data type', async () => {
    const g = new EnvGraph();
    await g.setRootDataSource(new DotEnvFileDataSource('.env.schema', {
      overrideContents: outdent`
        # @defaultRequired=false @defaultSensitive=false
        # ---
        API_DOMAIN=domainFromUrl("https://api.example.com/v1")
        PLAIN=concat("a", "b")
      `,
    }));
    await g.finishLoad();
    await g.resolveEnvValues();
    expect(g.configSchema.API_DOMAIN.dataType?.name).toBe('domain');
    expect(g.configSchema.PLAIN.dataType?.name).toBe('string');
  });
});

// --------

describe('dependency cycles', functionValueTests({
  'detect cycle - self': {
    input: 'A=$A',
    expected: { A: SchemaError },
  },
  'detect cycle - self within nested fn': {
    input: 'A="foo-$A-bar"',
    expected: { A: SchemaError },
  },
  'detect cycle - pair': {
    input: outdent`
      A=$B
      B=$A
    `,
    expected: { A: SchemaError, B: SchemaError },
  },
  'detect cycle - >2 items': {
    input: outdent`
      A=$B
      B=$C
      C=$A
    `,
    expected: { A: SchemaError, B: SchemaError, C: SchemaError },
  },
}));

describe('unknown resolver', functionValueTests({
  'unknown resolver fn': {
    input: 'ITEM=bad()',
    expected: { ITEM: SchemaError },
  },
  'unknown resolver fn nested': {
    input: 'ITEM=concat(a, bad(), c)',
    expected: { ITEM: SchemaError },
  },
}));

describe('resolveItemWithDeps()', () => {
  it('resolves a single item and its transitive dependencies', async () => {
    IncrementResolver.counter = 0;
    const g = new EnvGraph();
    g.registerResolver(IncrementResolver);
    const testDataSource = new DotEnvFileDataSource('.env.schema', {
      overrideContents: outdent`
        # @defaultRequired=false
        # ---
        A=a-val
        B=$A
        C=c-val
        UNREACHABLE=concat(increment(), increment())
      `,
    });
    await g.setRootDataSource(testDataSource);
    await g.finishLoad();

    // Only resolve B (and its dependency A), not C or UNREACHABLE
    await g.resolveItemWithDeps('B');

    expect(g.configSchema.A.resolvedValue).toEqual('a-val');
    expect(g.configSchema.B.resolvedValue).toEqual('a-val');
    // C and UNREACHABLE should not have been resolved
    expect(g.configSchema.C.resolvedValue).toBeUndefined();
    // increment() should not have been called (counter stays at 0)
    expect(IncrementResolver.counter).toEqual(0);
  });
});
