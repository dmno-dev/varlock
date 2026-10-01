import { describe, expect, test } from 'vitest';
import { canonicalizeRequestTarget, substitutedPathKeepsStructure } from './request-target';
import { evaluateProxyPolicy, getRequestScopedManagedItems, ruleMatchesFacts } from './policy';
import type { ProxyManagedItem, ProxyRule } from './types';

const ok = (raw: string) => {
  const r = canonicalizeRequestTarget(raw);
  if (!r.ok) throw new Error(`expected ok for ${raw}, got: ${r.reason}`);
  return r;
};
const rejected = (raw: string) => {
  const r = canonicalizeRequestTarget(raw);
  return r.ok ? undefined : r.reason;
};

describe('canonicalizeRequestTarget', () => {
  test('leaves an ordinary path alone and keeps the query verbatim', () => {
    expect(ok('/v1/customers/42')).toMatchObject({ pathOnly: '/v1/customers/42', requestTarget: '/v1/customers/42' });
    expect(ok('/v1/x?a=1&b=%2F..%2F')).toMatchObject({ pathOnly: '/v1/x', requestTarget: '/v1/x?a=1&b=%2F..%2F' });
    expect(ok('/')).toMatchObject({ pathOnly: '/', requestTarget: '/' });
    expect(ok('*')).toMatchObject({ pathOnly: '*', requestTarget: '*' });
  });

  test('resolves dot segments the way an upstream router would', () => {
    expect(ok('/v1/charges/../refunds/re_1').pathOnly).toBe('/v1/refunds/re_1');
    expect(ok('/./v1/refunds/re_1').pathOnly).toBe('/v1/refunds/re_1');
    expect(ok('/v1/./refunds/./re_1').pathOnly).toBe('/v1/refunds/re_1');
    expect(ok('/a/b/../../c').pathOnly).toBe('/c');
    expect(ok('/a/..').pathOnly).toBe('/');
  });

  test('collapses empty segments and preserves a trailing slash', () => {
    expect(ok('//v1/refunds/re_1').pathOnly).toBe('/v1/refunds/re_1');
    expect(ok('/v1//refunds///re_1').pathOnly).toBe('/v1/refunds/re_1');
    expect(ok('/v1/refunds/').pathOnly).toBe('/v1/refunds/');
    expect(ok('/v1/refunds//').pathOnly).toBe('/v1/refunds/');
  });

  test('decodes unreserved percent-escapes and uppercases the rest', () => {
    expect(ok('/v1/%72efunds/re_1').pathOnly).toBe('/v1/refunds/re_1');
    expect(ok('/v1/%2e%2E/refunds').pathOnly).toBe('/refunds');
    expect(ok('/v1/a%20b/%c3%a9').pathOnly).toBe('/v1/a%20b/%C3%A9');
    expect(ok('/v1/a%7Eb').pathOnly).toBe('/v1/a~b');
  });

  test('rejects what it cannot canonicalize unambiguously', () => {
    expect(rejected('https://attacker.example/')).toMatch(/origin form/);
    expect(rejected('v1/refunds')).toMatch(/origin form/);
    expect(rejected('/../etc')).toMatch(/above the root/);
    expect(rejected('/v1/%2e%2e/../../x')).toMatch(/above the root/);
    expect(rejected('/..;/etc')).toMatch(/above the root once/);
    expect(rejected('/v1/%3b/x')).toMatch(/percent-encoding/);
    expect(rejected('/v1/refunds#/../re_1')).toMatch(/fragment/);
    expect(rejected('/v1/refunds#?x=1')).toMatch(/fragment/);
    expect(ok('/v1/refunds?x=%23').pathOnly).toBe('/v1/refunds');
    expect(rejected('/v1/charges%2F..%2Frefunds')).toMatch(/percent-encoding/);
    expect(rejected('/v1/charges%5c..%5crefunds')).toMatch(/percent-encoding/);
    expect(rejected('/v1/%00')).toMatch(/percent-encoding/);
    expect(rejected('/v1/%zz')).toMatch(/percent-encoding/);
    expect(rejected('/v1/%2')).toMatch(/percent-encoding/);
    expect(rejected('/v1\\refunds')).toMatch(/backslash/);
    expect(rejected('/v1/re funds')).toMatch(/whitespace/);
    expect(rejected('/v1/re\tfunds')).toMatch(/control/);
  });
});

describe('`;` path parameters report every routed form', () => {
  test('an ordinary path has no alternate routed form', () => {
    expect(ok('/v1/refunds/re_1').routedPaths).toEqual([]);
    expect(ok('/v1/refunds/re_1?a=b;c').routedPaths).toEqual([]);
    expect(ok('*').routedPaths).toEqual([]);
  });

  test('keeps the literal form upstream and reports the servlet-stripped form', () => {
    // servlet containers map `/v1/refunds;jsessionid=x/re_1` as `/v1/refunds/re_1`,
    // everything else routes on the literal text: policy sees both
    expect(ok('/v1/refunds;jsessionid=x/re_1')).toMatchObject({
      pathOnly: '/v1/refunds;jsessionid=x/re_1', routedPaths: ['/v1/refunds/re_1'],
    });
    expect(ok('/v1/refunds/re_1;x')).toMatchObject({ pathOnly: '/v1/refunds/re_1;x', routedPaths: ['/v1/refunds/re_1'] });
    // the stripped form goes through dot and empty-segment resolution too
    expect(ok('/v1/charges/..;/refunds/re_1').routedPaths).toEqual(['/v1/refunds/re_1']);
    expect(ok('/v1/.;jsessionid=x/refunds/re_1').routedPaths).toEqual(['/v1/refunds/re_1']);
    expect(ok('/v1/;/refunds/re_1').routedPaths).toEqual(['/v1/refunds/re_1']);
    expect(ok('/v1/;x/refunds/re_1/').routedPaths).toEqual(['/v1/refunds/re_1/']);
  });

  test('a block rule matches if any routed form matches; an allow rule only if all do', () => {
    const block: ProxyRule = {
      domain: ['x'], path: '/v1/refunds/**', block: true, itemKeys: [],
    };
    const allowRefunds: ProxyRule = { domain: ['x'], path: '/v1/refunds/**', itemKeys: [] };
    const allowAll: ProxyRule = { domain: ['x'], path: '/v1/**', itemKeys: [] };
    const target = ok('/v1/refunds;jsessionid=x/re_1');
    const facts = {
      host: 'x', method: 'GET', path: target.pathOnly, routedPaths: target.routedPaths,
    };
    expect(ruleMatchesFacts(block, facts)).toBe(true); // via the stripped form
    expect(ruleMatchesFacts(allowRefunds, facts)).toBe(false); // literal form has `;jsessionid=x`
    expect(ruleMatchesFacts(allowAll, facts)).toBe(true); // both forms are under /v1/
    expect(evaluateProxyPolicy(facts, [allowAll, block], 'permissive')).toMatchObject({ verdict: 'deny', denyKind: 'block' });
    expect(evaluateProxyPolicy(facts, [allowRefunds], 'strict')).toMatchObject({ verdict: 'deny', denyKind: 'egress-strict' });
    expect(evaluateProxyPolicy(facts, [allowAll], 'strict')).toMatchObject({ verdict: 'allow' });
  });
});

describe('canonicalized paths close the block-rule bypass', () => {
  const rules: Array<ProxyRule> = [
    { domain: ['api.stripe.com'], itemKeys: ['STRIPE'] },
    {
      domain: ['api.stripe.com'], path: '/v1/refunds/**', method: ['POST', 'DELETE'], block: true, itemKeys: [],
    },
  ];
  const items: Array<ProxyManagedItem> = [
    {
      key: 'STRIPE', placeholder: 'sk_test_PLACEHOLDER', realValue: 'sk_live_REAL', isSensitive: true,
    },
  ];

  test.each([
    '/v1/charges/../refunds/re_1',
    '//v1/refunds/re_1',
    '/./v1/refunds/re_1',
    '/v1/%72efunds/re_1',
    '/v1/charges/%2e%2e/refunds/re_1',
    '/v1/charges/..;/refunds/re_1',
    '/v1/refunds;jsessionid=x/re_1',
  ])('%s is denied by the refunds block rule and injects nothing', (raw) => {
    const target = ok(raw);
    const facts = {
      host: 'api.stripe.com', method: 'POST', path: target.pathOnly, routedPaths: target.routedPaths,
    };
    expect(evaluateProxyPolicy(facts, rules, 'strict')).toMatchObject({ verdict: 'deny', denyKind: 'block' });
    // The block verdict stops the request before injection, but even the scoped
    // set should be judged on every routed form.
    expect([target.pathOnly, ...target.routedPaths]).toContain('/v1/refunds/re_1');
    expect(getRequestScopedManagedItems(facts, rules, items).map((i) => i.key)).toEqual(['STRIPE']);
  });

  test('substituting a value into the path may not change its structure', () => {
    const base = '/v1/sk-stub-PLACEHOLDER/data';
    expect(substitutedPathKeepsStructure(base, base)).toBe(true);
    expect(substitutedPathKeepsStructure(base, '/v1/sk-stub-REALKEY/data')).toBe(true);
    expect(substitutedPathKeepsStructure(base, '/v1/a%20b~c.d/data')).toBe(true);
    // structural characters in the value move the request off the authorized path
    expect(substitutedPathKeepsStructure(base, '/v1/../admin/data')).toBe(false);
    expect(substitutedPathKeepsStructure(base, '/v1/a/b/data')).toBe(false);
    expect(substitutedPathKeepsStructure(base, '/v1//data')).toBe(false);
    expect(substitutedPathKeepsStructure(base, '/v1/x?admin=1/data')).toBe(false);
    expect(substitutedPathKeepsStructure(base, '/v1/x#frag/data')).toBe(false);
    expect(substitutedPathKeepsStructure(base, '/v1/x%2Fy/data')).toBe(false);
    expect(substitutedPathKeepsStructure(base, '/v1/x%2e%2e/data')).toBe(false);
    // a `;` in the value is fine while every routed form keeps the segment
    // count; one a servlet router would strip to an empty or dot segment is not
    expect(substitutedPathKeepsStructure(base, '/v1/x;y/data')).toBe(true);
    expect(substitutedPathKeepsStructure(base, '/v1/;y/data')).toBe(false);
    expect(substitutedPathKeepsStructure(base, '/v1/..;y/data')).toBe(false);
    expect(substitutedPathKeepsStructure(base, '/v1/x y/data')).toBe(false);
    expect(substitutedPathKeepsStructure(base, '/v1/100%/data')).toBe(false);
  });

  test('strict egress with a path allow rule does not let a dot segment reach a sibling path', () => {
    const scoped: Array<ProxyRule> = [{ domain: ['api.stripe.com'], path: '/v1/charges/**', itemKeys: ['STRIPE'] }];
    const target = ok('/v1/charges/../refunds/re_1');
    const decision = evaluateProxyPolicy({ host: 'api.stripe.com', method: 'POST', path: target.pathOnly }, scoped, 'strict');
    expect(decision).toMatchObject({ verdict: 'deny', denyKind: 'egress-strict' });
  });
});
