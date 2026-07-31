import {
  DEFAULT_PROXY_MAX_OCCURRENCES, DEFAULT_PROXY_SUBSTITUTION_TARGETS,
  parseProxySubstitutionTarget, proxySubstitutionTargetKey,
  type ProxyEgressMode, type ProxyManagedItem, type ProxyRule, type ProxySubstitutionTarget,
} from './types';

/**
 * A managed item scoped to a single request, carrying the merged substitution
 * policy from the matching rules that inject it: the `targets` its placeholder may
 * be substituted at, and the per-request `maxOccurrences` cap. Both are the union /
 * max across the active contributing rules (any rule that adds a target or raises
 * the cap wins), defaulting to any-header / once.
 */
export type RequestScopedManagedItem = ProxyManagedItem & {
  targets: Array<ProxySubstitutionTarget>;
  maxOccurrences: number;
};

/**
 * Normalized facts extracted from a request, the input to every policy
 * decision. Kept deliberately generic (a "fact bag") so non-HTTP protocols and
 * domain plugins can enrich it later without changing the evaluation interface.
 */
export type RequestFacts = {
  host: string;
  method: string;
  /** Path only (no query string), e.g. `/v1/customers/42`. */
  path: string;
};

export type PolicyVerdict = 'allow' | 'deny' | 'require-approval';

export type PolicyDecision = {
  verdict: PolicyVerdict;
  matchedRule?: ProxyRule;
  reason?: string;
  /**
   * For a `deny`, why it was denied:
   *  - `block`: an explicit `@proxy(block=true)` rule matched (denylist).
   *  - `egress-strict`: strict egress and no allow rule matched this request
   *    (the host may have `@proxy` rules, just none for this method + path).
   */
  denyKind?: 'block' | 'egress-strict';
};

export function normalizeHost(host: string): string {
  return host.toLowerCase().trim();
}

export function domainMatches(domainPattern: string, host: string): boolean {
  const pattern = normalizeHost(domainPattern);
  const normalizedHost = normalizeHost(host);
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(2);
    return normalizedHost === suffix || normalizedHost.endsWith(`.${suffix}`);
  }
  return normalizedHost === pattern;
}

/**
 * Glob path match: `*` matches within a single path segment, `**` matches
 * across segments. Everything else is literal. `pathRegex` (a future option)
 * would be the escape hatch for anything globs can't express.
 */
function pathMatches(pattern: string, path: string): boolean {
  const re = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    // `**` → cross-segment, `*` → within-segment (alternation matches `**` first)
    .replace(/\*\*|\*/g, (match) => (match === '**' ? '.*' : '[^/]*'));
  return new RegExp(`^${re}$`).test(path);
}

function methodMatches(ruleMethods: Array<string>, method: string): boolean {
  const allowed = ruleMethods.map((m) => m.trim().toUpperCase()).filter(Boolean);
  return allowed.length === 0 || allowed.includes(method.toUpperCase());
}

/** Whether a rule's match constraints (domain + optional path + optional method) all hold for the facts. */
export function ruleMatchesFacts(rule: ProxyRule, facts: RequestFacts): boolean {
  if (!rule.domain.some((d) => domainMatches(d, facts.host))) return false;
  if (rule.path !== undefined && !pathMatches(rule.path, facts.path)) return false;
  if (rule.method !== undefined && !methodMatches(rule.method, facts.method)) return false;
  return true;
}

/** A rule with path/method constraints is more specific than a domain-only rule. */
function ruleSpecificity(rule: ProxyRule): number {
  return (rule.path !== undefined ? 2 : 0) + (rule.method !== undefined ? 1 : 0);
}

/**
 * A stable, human-readable identifier for a rule, derived from its match
 * constraints (rules have no explicit id). Used as the audit log's `ruleId` so
 * a logged decision can be traced back to the rule that produced it.
 */
export function describeRule(rule: ProxyRule): string {
  const parts = [rule.domain.join('|')];
  if (rule.method !== undefined) parts.push(rule.method.map((m) => m.toUpperCase()).join('|'));
  if (rule.path !== undefined) parts.push(rule.path);
  if (rule.block) parts.push('block');
  if (rule.approval) parts.push('approval');
  return parts.join(' ');
}

/**
 * Evaluate the policy for a request. Precedence (most restrictive wins):
 *   1. any matching `block` rule → deny. **Block always wins over allow**,
 *      regardless of rule order or specificity — so a specific allow cannot carve
 *      an exception out of a matching block. (To allow a subset and deny the rest,
 *      use strict egress + a specific allow rule, not a broad block + narrow allow.)
 *   2. else the most-specific tier of non-block (allow) rules decides: an
 *      `approval` rule in that tier → require-approval, otherwise allow.
 *   3. no matching rule:
 *      - `permissive` egress → allow (injection scoping is handled separately, so
 *        an allow verdict doesn't imply a secret is injected).
 *      - `strict` egress → deny (`egress-strict`): only requests matching an allow
 *        rule may pass, so a ruled host on a non-matching method/path is blocked.
 *
 * Tie-break within the most-specific allow tier is conservative: an `approval` rule
 * beats a plain allow, so a broad allow can't silently downgrade a specific
 * require-approval, and a specific allow can still exempt a safe path from a broad
 * approval.
 */
export function evaluateProxyPolicy(
  facts: RequestFacts,
  rules: Array<ProxyRule>,
  egressMode: ProxyEgressMode = 'permissive',
): PolicyDecision {
  const matching = rules.filter((rule) => ruleMatchesFacts(rule, facts));

  const blockRule = matching
    .filter((rule) => rule.block)
    .sort((a, b) => ruleSpecificity(b) - ruleSpecificity(a))[0];
  if (blockRule) {
    return {
      verdict: 'deny', matchedRule: blockRule, reason: 'blocked by @proxy(block=true) rule', denyKind: 'block',
    };
  }

  const nonBlock = matching.filter((rule) => !rule.block);
  if (nonBlock.length === 0) {
    if (egressMode === 'strict') {
      return { verdict: 'deny', reason: 'no allow rule matches this request (strict egress)', denyKind: 'egress-strict' };
    }
    return { verdict: 'allow' };
  }
  const maxSpecificity = Math.max(...nonBlock.map(ruleSpecificity));
  const topTier = nonBlock.filter((rule) => ruleSpecificity(rule) === maxSpecificity);
  const approvalRule = topTier.find((rule) => rule.approval);
  if (approvalRule) {
    return {
      verdict: 'require-approval',
      matchedRule: approvalRule,
      reason: 'requires approval per @proxy(approval=...) rule',
    };
  }
  return { verdict: 'allow', matchedRule: topTier[0] };
}

/**
 * The managed items in scope for a specific request: items referenced by a
 * non-block rule whose full match (domain + path + method) holds for the facts.
 * This extends per-item domain scoping with path/method scoping, so a credential
 * can be limited to specific endpoints/methods, not just a host.
 *
 * Approval-awareness (Invariant #8): a key contributed *only* by rules that
 * require approval is **approval-gated** and is withheld unless
 * `includeApprovalGatedKeys` is set — which the caller does only when the policy
 * verdict is `require-approval` (i.e. the approval gate runs and must pass before
 * anything is injected). This closes a downgrade: the policy verdict is decided by
 * the single most-specific rule tier, so a more-specific plain-allow rule (e.g.
 * exempting `/health`) yields an `allow` verdict and skips the approval gate — but
 * a broader `@proxy(approval)` rule still matches the request. Unioning its keys
 * unconditionally would inject an approval-gated secret with no prompt. A key that
 * is *also* reachable via any plain-allow rule stays unconditional (the author
 * granted it a non-approval path), so exempting a path still works — you just have
 * to attach the key to the exempting rule to inject it there without approval.
 */
export function getRequestScopedManagedItems(
  facts: RequestFacts,
  rules: Array<ProxyRule>,
  managedItems: Array<ProxyManagedItem>,
  opts?: { includeApprovalGatedKeys?: boolean },
): Array<RequestScopedManagedItem> {
  const unconditionalKeys = new Set<string>();
  const approvalGatedKeys = new Set<string>();
  for (const rule of rules) {
    if (rule.block) continue;
    if (!ruleMatchesFacts(rule, facts)) continue;
    for (const key of rule.itemKeys) {
      if (rule.approval) approvalGatedKeys.add(key);
      else unconditionalKeys.add(key);
    }
  }
  const allowedKeys = new Set(unconditionalKeys);
  if (opts?.includeApprovalGatedKeys) {
    for (const key of approvalGatedKeys) allowedKeys.add(key);
  }
  if (allowedKeys.size === 0) return [];

  // Merge the substitution policy (targets + occurrence cap) for each allowed key,
  // but only from rules whose contribution is *active* for this request: plain-allow
  // rules always; approval rules only when the approval gate runs
  // (`includeApprovalGatedKeys`). This mirrors the key-scoping above so a withheld
  // approval rule can't quietly widen where a key may be substituted.
  const targetsByKey = new Map<string, Map<string, ProxySubstitutionTarget>>();
  const maxOccByKey = new Map<string, number>();
  for (const rule of rules) {
    if (rule.block) continue;
    if (rule.approval && !opts?.includeApprovalGatedKeys) continue;
    if (!ruleMatchesFacts(rule, facts)) continue;
    const ruleTargets = rule.substituteIn?.length
      ? rule.substituteIn
        .map((raw) => parseProxySubstitutionTarget(raw))
        .flatMap((r) => (r.ok ? [r.target] : []))
      : DEFAULT_PROXY_SUBSTITUTION_TARGETS;
    const ruleMaxOcc = rule.maxOccurrences ?? DEFAULT_PROXY_MAX_OCCURRENCES;
    for (const key of rule.itemKeys) {
      if (!allowedKeys.has(key)) continue;
      let targets = targetsByKey.get(key);
      if (!targets) {
        targets = new Map<string, ProxySubstitutionTarget>();
        targetsByKey.set(key, targets);
      }
      for (const target of ruleTargets) targets.set(proxySubstitutionTargetKey(target), target);
      maxOccByKey.set(key, Math.max(maxOccByKey.get(key) ?? 0, ruleMaxOcc));
    }
  }

  return managedItems
    .filter((item) => allowedKeys.has(item.key))
    .map((item) => ({
      ...item,
      targets: [...(targetsByKey.get(item.key)?.values() ?? DEFAULT_PROXY_SUBSTITUTION_TARGETS)],
      maxOccurrences: maxOccByKey.get(item.key) ?? DEFAULT_PROXY_MAX_OCCURRENCES,
    }));
}
