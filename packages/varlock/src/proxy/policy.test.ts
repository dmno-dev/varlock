import { describe, expect, test } from 'vitest';

import {
  evaluateProxyPolicy, getRequestScopedManagedItems, ruleMatchesFacts, type RequestFacts,
} from './policy';
import type { ProxyManagedItem, ProxyRule } from './types';

const rule = (partial: Partial<ProxyRule>): ProxyRule => ({
  domain: [], itemKeys: [], ...partial,
});
const facts = (host: string, method: string, path: string): RequestFacts => ({ host, method, path });

describe('proxy policy matching', () => {
  test('matches on domain + path glob + method', () => {
    const r = rule({ domain: ['api.x.com'], path: '/v1/customers/*', method: ['GET'] });
    expect(ruleMatchesFacts(r, facts('api.x.com', 'GET', '/v1/customers/42'))).toBe(true);
    // method mismatch
    expect(ruleMatchesFacts(r, facts('api.x.com', 'POST', '/v1/customers/42'))).toBe(false);
    // `*` is a single segment — does not cross `/`
    expect(ruleMatchesFacts(r, facts('api.x.com', 'GET', '/v1/customers/42/charges'))).toBe(false);
    // domain mismatch
    expect(ruleMatchesFacts(r, facts('evil.com', 'GET', '/v1/customers/42'))).toBe(false);
  });

  test('`**` matches across segments; method lists; domain-only matches any path/method', () => {
    expect(ruleMatchesFacts(rule({ domain: ['api.x.com'], path: '/v1/**' }), facts('api.x.com', 'GET', '/v1/a/b/c'))).toBe(true);
    expect(ruleMatchesFacts(rule({ domain: ['api.x.com'], method: ['GET', 'POST'] }), facts('api.x.com', 'POST', '/any'))).toBe(true);
    expect(ruleMatchesFacts(rule({ domain: ['api.x.com'] }), facts('api.x.com', 'DELETE', '/whatever'))).toBe(true);
  });
});

describe('evaluateProxyPolicy', () => {
  const rules = [
    rule({ domain: ['api.stripe.com'], itemKeys: ['STRIPE_KEY'] }),
    rule({
      domain: ['api.stripe.com'], path: '/v1/charges', method: ['POST'], block: true,
    }),
  ];

  test('block rule denies the specific endpoint, allows the rest', () => {
    expect(evaluateProxyPolicy(facts('api.stripe.com', 'POST', '/v1/charges'), rules).verdict).toBe('deny');
    expect(evaluateProxyPolicy(facts('api.stripe.com', 'GET', '/v1/customers'), rules).verdict).toBe('allow');
  });

  test('block wins even when an allow rule also matches', () => {
    const both = [
      rule({ domain: ['api.x.com'], itemKeys: ['K'] }),
      rule({ domain: ['api.x.com'], path: '/danger', block: true }),
    ];
    expect(evaluateProxyPolicy(facts('api.x.com', 'GET', '/danger'), both).verdict).toBe('deny');
  });

  test('an approve rule yields require-approval', () => {
    const approveRules = [rule({ domain: ['api.x.com'], path: '/v1/refunds/**', approval: true })];
    expect(evaluateProxyPolicy(facts('api.x.com', 'POST', '/v1/refunds/42'), approveRules).verdict).toBe('require-approval');
    // a non-matching path falls through to allow
    expect(evaluateProxyPolicy(facts('api.x.com', 'GET', '/v1/customers'), approveRules).verdict).toBe('allow');
  });

  test('block beats require-approval beats allow', () => {
    const layered = [
      rule({ domain: ['api.x.com'] }), // broad allow
      rule({ domain: ['api.x.com'], path: '/admin/**', approval: true }),
      rule({ domain: ['api.x.com'], path: '/admin/destroy', block: true }),
    ];
    expect(evaluateProxyPolicy(facts('api.x.com', 'GET', '/admin/destroy'), layered).verdict).toBe('deny');
    expect(evaluateProxyPolicy(facts('api.x.com', 'GET', '/admin/settings'), layered).verdict).toBe('require-approval');
    expect(evaluateProxyPolicy(facts('api.x.com', 'GET', '/public'), layered).verdict).toBe('allow');
  });

  test('a more-specific allow exempts a path from a broad approve', () => {
    const broadApprove = [
      rule({ domain: ['api.x.com'], approval: true }), // approve everything by default
      rule({ domain: ['api.x.com'], path: '/health' }), // ...except this safe path
    ];
    expect(evaluateProxyPolicy(facts('api.x.com', 'GET', '/anything'), broadApprove).verdict).toBe('require-approval');
    expect(evaluateProxyPolicy(facts('api.x.com', 'GET', '/health'), broadApprove).verdict).toBe('allow');
  });

  test('on a specificity tie, require-approval wins over allow (more restrictive)', () => {
    const tied = [
      rule({ domain: ['api.x.com'], path: '/v1/*' }),
      rule({ domain: ['api.x.com'], path: '/v1/*', approval: true }),
    ];
    expect(evaluateProxyPolicy(facts('api.x.com', 'GET', '/v1/x'), tied).verdict).toBe('require-approval');
  });
});

describe('getRequestScopedManagedItems', () => {
  const items: Array<ProxyManagedItem> = [{ key: 'K', placeholder: 'PH', realValue: 'REAL' }];

  test('injects only when domain + path + method all match', () => {
    const rules = [
      rule({
        domain: ['api.x.com'], path: '/v1/read/*', method: ['GET'], itemKeys: ['K'],
      }),
    ];
    expect(getRequestScopedManagedItems(facts('api.x.com', 'GET', '/v1/read/1'), rules, items).map((i) => i.key)).toEqual(['K']);
    expect(getRequestScopedManagedItems(facts('api.x.com', 'POST', '/v1/read/1'), rules, items)).toEqual([]);
    expect(getRequestScopedManagedItems(facts('api.x.com', 'GET', '/v1/write/1'), rules, items)).toEqual([]);
  });

  test('a block rule never contributes injection items', () => {
    const rules = [rule({ domain: ['api.x.com'], block: true, itemKeys: ['K'] })];
    expect(getRequestScopedManagedItems(facts('api.x.com', 'GET', '/'), rules, items)).toEqual([]);
  });
});
