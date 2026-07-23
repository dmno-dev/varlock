import { describe, expect, test } from 'vitest';

import {
  evaluateProxyPolicy, getRequestScopedManagedItems, ruleMatchesFacts, type RequestFacts,
} from './policy';
import type { ProxyManagedItem, ProxyRule } from './types';

const rule = (partial: Partial<ProxyRule>): ProxyRule => ({
  domain: [], itemKeys: [], ...partial,
});
const facts = (host: string, method: string, path: string): RequestFacts => ({ host, method, path });
const keysOf = (items: Array<ProxyManagedItem>) => items.map((i) => i.key);

// ─────────────────────────────────────────────────────────────────────────────
// Matching primitives (domain / path / method) — security-critical: a wrong
// match injects a secret to (or opens egress toward) the wrong place.
// ─────────────────────────────────────────────────────────────────────────────

describe('domain matching', () => {
  const matchesHost = (domain: string, host: string) => ruleMatchesFacts(rule({ domain: [domain] }), facts(host, 'GET', '/'));

  test('exact host, case-insensitive, only that host', () => {
    expect(matchesHost('api.x.com', 'api.x.com')).toBe(true);
    expect(matchesHost('api.x.com', 'API.X.COM')).toBe(true);
    expect(matchesHost('api.x.com', 'sub.api.x.com')).toBe(false);
    expect(matchesHost('api.x.com', 'api.x.com.evil.com')).toBe(false);
    expect(matchesHost('api.x.com', 'notapi.x.com')).toBe(false);
  });

  test('`*.example.com` matches the apex and any subdomain depth', () => {
    expect(matchesHost('*.example.com', 'example.com')).toBe(true);
    expect(matchesHost('*.example.com', 'api.example.com')).toBe(true);
    expect(matchesHost('*.example.com', 'a.b.example.com')).toBe(true);
  });

  test('`*.example.com` does NOT match look-alikes (no suffix confusion)', () => {
    expect(matchesHost('*.example.com', 'evilexample.com')).toBe(false);
    expect(matchesHost('*.example.com', 'example.com.evil.com')).toBe(false);
    expect(matchesHost('*.example.com', 'notexample.com')).toBe(false);
  });

  test('a domain array matches if any entry matches', () => {
    const r = rule({ domain: ['api.a.com', 'api.b.com'] });
    expect(ruleMatchesFacts(r, facts('api.b.com', 'GET', '/'))).toBe(true);
    expect(ruleMatchesFacts(r, facts('api.c.com', 'GET', '/'))).toBe(false);
  });
});

describe('path matching', () => {
  const matchesPath = (pattern: string, path: string) => ruleMatchesFacts(rule({ domain: ['x'], path: pattern }), facts('x', 'GET', path));

  test('exact path is anchored (no prefix/suffix bleed)', () => {
    expect(matchesPath('/v1/charges', '/v1/charges')).toBe(true);
    expect(matchesPath('/v1/charges', '/v1/charges/42')).toBe(false);
    expect(matchesPath('/v1/charges', '/v1/chargesX')).toBe(false);
    expect(matchesPath('/v1/charges', '/prefix/v1/charges')).toBe(false);
  });

  test('`*` matches within one segment, not across `/`', () => {
    expect(matchesPath('/v1/*', '/v1/x')).toBe(true);
    expect(matchesPath('/v1/*', '/v1/x/y')).toBe(false);
    expect(matchesPath('/v1/*', '/v1/')).toBe(true);
  });

  test('`**` matches across segments', () => {
    expect(matchesPath('/v1/**', '/v1/x/y/z')).toBe(true);
    expect(matchesPath('/v1/**', '/v1/')).toBe(true);
    expect(matchesPath('/**', '/anything/at/all')).toBe(true);
  });

  test('regex metacharacters in the pattern are literal', () => {
    // `.` must be a literal dot, not "any char"
    expect(matchesPath('/file.txt', '/file.txt')).toBe(true);
    expect(matchesPath('/file.txt', '/fileXtxt')).toBe(false);
    // `+`, `(`, `)` literal too
    expect(matchesPath('/a+b', '/a+b')).toBe(true);
    expect(matchesPath('/a+b', '/aaab')).toBe(false);
  });

  test('undefined path matches any path', () => {
    expect(ruleMatchesFacts(rule({ domain: ['x'] }), facts('x', 'GET', '/anything/here'))).toBe(true);
  });
});

describe('method matching', () => {
  const matchesMethod = (methods: Array<string> | undefined, method: string) => ruleMatchesFacts(rule({ domain: ['x'], ...(methods ? { method: methods } : {}) }), facts('x', method, '/'));

  test('case-insensitive, list membership', () => {
    expect(matchesMethod(['GET', 'POST'], 'post')).toBe(true);
    expect(matchesMethod(['GET'], 'DELETE')).toBe(false);
  });

  test('undefined or empty method list matches any method', () => {
    expect(matchesMethod(undefined, 'PATCH')).toBe(true);
    expect(matchesMethod([], 'PATCH')).toBe(true);
  });
});

describe('ruleMatchesFacts — all constraints must hold', () => {
  test('domain + path + method combined', () => {
    const r = rule({ domain: ['api.x.com'], path: '/v1/customers/*', method: ['GET'] });
    expect(ruleMatchesFacts(r, facts('api.x.com', 'GET', '/v1/customers/42'))).toBe(true);
    expect(ruleMatchesFacts(r, facts('api.x.com', 'POST', '/v1/customers/42'))).toBe(false); // method
    expect(ruleMatchesFacts(r, facts('api.x.com', 'GET', '/v1/customers/42/charges'))).toBe(false); // path (`*`)
    expect(ruleMatchesFacts(r, facts('evil.com', 'GET', '/v1/customers/42'))).toBe(false); // domain
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Precedence: allow < require-approval < block (block always wins).
// ─────────────────────────────────────────────────────────────────────────────

describe('evaluateProxyPolicy — precedence (allow < approval < block)', () => {
  test('block wins over a matching allow rule, regardless of order/specificity', () => {
    const broadBlockNarrowAllow = [
      rule({ domain: ['api.x.com'], block: true }), // broad block
      rule({ domain: ['api.x.com'], path: '/ok', itemKeys: ['K'] }), // specific allow
    ];
    expect(evaluateProxyPolicy(facts('api.x.com', 'GET', '/ok'), broadBlockNarrowAllow).verdict).toBe('deny');

    const narrowBlockBroadAllow = [
      rule({ domain: ['api.x.com'], itemKeys: ['K'] }), // broad allow
      rule({ domain: ['api.x.com'], path: '/danger', block: true }), // specific block
    ];
    expect(evaluateProxyPolicy(facts('api.x.com', 'GET', '/danger'), narrowBlockBroadAllow).verdict).toBe('deny');
    expect(evaluateProxyPolicy(facts('api.x.com', 'GET', '/safe'), narrowBlockBroadAllow).verdict).toBe('allow');
  });

  test('block wins over a matching approval rule', () => {
    const both = [
      rule({ domain: ['api.x.com'], path: '/admin/**', approval: {} }),
      rule({ domain: ['api.x.com'], path: '/admin/wipe', block: true }),
    ];
    expect(evaluateProxyPolicy(facts('api.x.com', 'POST', '/admin/wipe'), both).verdict).toBe('deny');
    expect(evaluateProxyPolicy(facts('api.x.com', 'POST', '/admin/list'), both).verdict).toBe('require-approval');
  });

  test('approval wins over allow within the most-specific tier', () => {
    const tied = [
      rule({ domain: ['api.x.com'], path: '/v1/*' }),
      rule({ domain: ['api.x.com'], path: '/v1/*', approval: {} }),
    ];
    expect(evaluateProxyPolicy(facts('api.x.com', 'GET', '/v1/x'), tied).verdict).toBe('require-approval');
  });

  test('a more-specific allow exempts a path from a broad approval', () => {
    const broadApprove = [
      rule({ domain: ['api.x.com'], approval: {} }), // approve everything
      rule({ domain: ['api.x.com'], path: '/health' }), // ...except this safe path
    ];
    expect(evaluateProxyPolicy(facts('api.x.com', 'GET', '/anything'), broadApprove).verdict).toBe('require-approval');
    expect(evaluateProxyPolicy(facts('api.x.com', 'GET', '/health'), broadApprove).verdict).toBe('allow');
  });

  test('full three-tier layering: block > approval > allow', () => {
    const layered = [
      rule({ domain: ['api.x.com'] }), // broad allow
      rule({ domain: ['api.x.com'], path: '/admin/**', approval: {} }),
      rule({ domain: ['api.x.com'], path: '/admin/destroy', block: true }),
    ];
    expect(evaluateProxyPolicy(facts('api.x.com', 'GET', '/admin/destroy'), layered).verdict).toBe('deny');
    expect(evaluateProxyPolicy(facts('api.x.com', 'GET', '/admin/settings'), layered).verdict).toBe('require-approval');
    expect(evaluateProxyPolicy(facts('api.x.com', 'GET', '/public'), layered).verdict).toBe('allow');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Egress model (single dial): permissive = allow unmatched · strict = allowlist.
// A blanket `@proxy(domain=X)` opens the whole domain; scoped rules allowlist it.
// ─────────────────────────────────────────────────────────────────────────────

describe('evaluateProxyPolicy — egress model', () => {
  const blanket = [rule({ domain: ['example.com'], itemKeys: ['K'] })]; // blanket allow
  const scoped = [rule({ domain: ['api.stripe.com'], path: '/v1/charges/**', itemKeys: ['K'] })];

  test('blanket allow opens every route on the domain (both modes)', () => {
    for (const mode of ['permissive', 'strict'] as const) {
      expect(evaluateProxyPolicy(facts('example.com', 'GET', '/whatever/here'), blanket, mode).verdict).toBe('allow');
    }
  });

  test('blanket + a specific block denies just that route, allows the rest', () => {
    const withBlock = [...blanket, rule({ domain: ['example.com'], path: '/dangerous/**', block: true })];
    expect(evaluateProxyPolicy(facts('example.com', 'POST', '/dangerous/x'), withBlock, 'strict').verdict).toBe('deny');
    expect(evaluateProxyPolicy(facts('example.com', 'GET', '/safe'), withBlock, 'strict').verdict).toBe('allow');
  });

  test('scoped rule: matching route allowed; other routes on the SAME host blocked under strict', () => {
    expect(evaluateProxyPolicy(facts('api.stripe.com', 'POST', '/v1/charges/42'), scoped, 'strict').verdict).toBe('allow');
    const d = evaluateProxyPolicy(facts('api.stripe.com', 'GET', '/v1/refunds'), scoped, 'strict');
    expect(d.verdict).toBe('deny');
    expect(d.denyKind).toBe('egress-strict');
  });

  test('permissive lets an unmatched route pass through (single-dial: permissive means permissive)', () => {
    expect(evaluateProxyPolicy(facts('api.stripe.com', 'GET', '/v1/refunds'), scoped, 'permissive').verdict).toBe('allow');
  });

  test('block still wins under strict (denyKind=block, not egress-strict)', () => {
    const both = [
      rule({ domain: ['api.x.com'], path: '/v1/**', itemKeys: ['K'] }),
      rule({ domain: ['api.x.com'], path: '/v1/refunds/**', block: true }),
    ];
    const d = evaluateProxyPolicy(facts('api.x.com', 'POST', '/v1/refunds/9'), both, 'strict');
    expect(d.verdict).toBe('deny');
    expect(d.denyKind).toBe('block');
  });

  test('a matching approval rule still requires approval under strict; a non-matching route is egress-denied', () => {
    const approveRules = [rule({ domain: ['api.x.com'], path: '/admin/**', approval: {} })];
    expect(evaluateProxyPolicy(facts('api.x.com', 'GET', '/admin/x'), approveRules, 'strict').verdict).toBe('require-approval');
    expect(evaluateProxyPolicy(facts('api.x.com', 'GET', '/other'), approveRules, 'strict').denyKind).toBe('egress-strict');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Injection scoping: a key is injected ONLY for the rule(s) it's attached to,
// scoped by domain + path + method — never for the domain in general.
// ─────────────────────────────────────────────────────────────────────────────

describe('getRequestScopedManagedItems — per-rule key scoping', () => {
  const items: Array<ProxyManagedItem> = [
    { key: 'A', placeholder: 'PH_A', realValue: 'RA' },
    { key: 'B', placeholder: 'PH_B', realValue: 'RB' },
  ];

  test('each key injects only on its own rule’s route, not across the shared domain', () => {
    const rules = [
      rule({ domain: ['api.x.com'], path: '/a/**', itemKeys: ['A'] }),
      rule({ domain: ['api.x.com'], path: '/b/**', itemKeys: ['B'] }),
    ];
    expect(keysOf(getRequestScopedManagedItems(facts('api.x.com', 'GET', '/a/1'), rules, items))).toEqual(['A']);
    // B's key is NOT injected on /a even though both rules share the domain
    expect(keysOf(getRequestScopedManagedItems(facts('api.x.com', 'GET', '/b/1'), rules, items))).toEqual(['B']);
    // a route matching neither rule injects nothing
    expect(getRequestScopedManagedItems(facts('api.x.com', 'GET', '/c/1'), rules, items)).toEqual([]);
  });

  test('scoping honors path AND method', () => {
    const rules = [
      rule({
        domain: ['api.x.com'], path: '/v1/read/*', method: ['GET'], itemKeys: ['A'],
      }),
    ];
    expect(keysOf(getRequestScopedManagedItems(facts('api.x.com', 'GET', '/v1/read/1'), rules, items))).toEqual(['A']);
    expect(getRequestScopedManagedItems(facts('api.x.com', 'POST', '/v1/read/1'), rules, items)).toEqual([]); // method
    expect(getRequestScopedManagedItems(facts('api.x.com', 'GET', '/v1/write/1'), rules, items)).toEqual([]); // path
  });

  test('a rule can inject several keys (keys=[...]); union across matching rules', () => {
    const rules = [rule({ domain: ['api.x.com'], path: '/combined', itemKeys: ['A', 'B'] })];
    expect(keysOf(getRequestScopedManagedItems(facts('api.x.com', 'GET', '/combined'), rules, items)).sort()).toEqual(['A', 'B']);
  });

  test('a block rule never contributes injection items', () => {
    const rules = [
      rule({
        domain: ['api.x.com'], block: true, itemKeys: ['A'],
      }),
    ];
    expect(getRequestScopedManagedItems(facts('api.x.com', 'GET', '/'), rules, items)).toEqual([]);
  });

  describe('approval-gated keys are withheld from a non-approval verdict', () => {
    // A broad approval rule carrying A, plus a more-specific plain-allow rule
    // exempting /health. On /health the verdict is `allow` (specificity wins), so
    // the approval gate is skipped — A must NOT be injected without a prompt.
    const rules = [
      rule({ domain: ['api.x.com'], itemKeys: ['A'], approval: { each: 'endpoint' } }),
      rule({ domain: ['api.x.com'], path: '/health', itemKeys: [] }),
    ];

    test('withheld by default (approval not in effect)', () => {
      expect(getRequestScopedManagedItems(facts('api.x.com', 'GET', '/health'), rules, items)).toEqual([]);
      // even on a path with no exempting rule, the default (approval-not-granted) withholds it
      expect(getRequestScopedManagedItems(facts('api.x.com', 'POST', '/charge'), rules, items)).toEqual([]);
    });

    test('included only when the caller signals approval is in effect', () => {
      expect(keysOf(getRequestScopedManagedItems(
        facts('api.x.com', 'POST', '/charge'),
        rules,
        items,
        { includeApprovalGatedKeys: true },
      ))).toEqual(['A']);
    });

    test('a key also reachable via a plain-allow rule stays unconditional', () => {
      const mixed = [
        rule({ domain: ['api.x.com'], itemKeys: ['A'], approval: { each: 'endpoint' } }),
        rule({ domain: ['api.x.com'], path: '/health', itemKeys: ['A'] }),
      ];
      // On /health, A is contributed by the plain-allow rule too → injected with no approval.
      expect(keysOf(getRequestScopedManagedItems(facts('api.x.com', 'GET', '/health'), mixed, items))).toEqual(['A']);
    });
  });

  describe('substitution policy (targets + occurrence cap)', () => {
    test('defaults to any-header, once, when the rule sets nothing', () => {
      const rules = [rule({ domain: ['api.x.com'], itemKeys: ['A'] })];
      const scoped = getRequestScopedManagedItems(facts('api.x.com', 'GET', '/'), rules, items);
      expect(scoped[0]).toMatchObject({ key: 'A', targets: [{ location: 'header' }], maxOccurrences: 1 });
    });

    test('parses named targets (header:name, body:path) + maxOccurrences onto the scoped item', () => {
      const rules = [
        rule({
          domain: ['api.x.com'], itemKeys: ['A'], substituteIn: ['header:authorization', 'body:client_secret'], maxOccurrences: 3,
        }),
      ];
      const scoped = getRequestScopedManagedItems(facts('api.x.com', 'GET', '/'), rules, items);
      expect(scoped[0]!.targets).toEqual([
        { location: 'header', name: 'authorization' },
        { location: 'body', path: 'client_secret' },
      ]);
      expect(scoped[0]!.maxOccurrences).toBe(3);
    });

    test('merges targets (union) and maxOccurrences (max) across matching rules', () => {
      const rules = [
        rule({ domain: ['api.x.com'], itemKeys: ['A'], substituteIn: ['header'] }),
        rule({
          domain: ['api.x.com'], path: '/**', itemKeys: ['A'], substituteIn: ['query:api_key'], maxOccurrences: 2,
        }),
      ];
      const scoped = getRequestScopedManagedItems(facts('api.x.com', 'GET', '/x'), rules, items);
      expect(scoped[0]!.targets).toEqual([
        { location: 'header' },
        { location: 'query', name: 'api_key' },
      ]);
      expect(scoped[0]!.maxOccurrences).toBe(2);
    });

    test('a withheld approval rule does not widen an unconditional key’s targets', () => {
      // A is unconditional via the plain-allow rule (header). A broad approval rule
      // also mentions A with a body path — but with approval not in effect, its
      // wider target must NOT leak into the scoped item.
      const rules = [
        rule({
          domain: ['api.x.com'], path: '/health', itemKeys: ['A'], substituteIn: ['header'],
        }),
        rule({
          domain: ['api.x.com'], itemKeys: ['A'], substituteIn: ['body:secret'], approval: { each: 'endpoint' },
        }),
      ];
      const scoped = getRequestScopedManagedItems(facts('api.x.com', 'GET', '/health'), rules, items);
      expect(scoped[0]!.targets).toEqual([{ location: 'header' }]);
    });
  });
});
