import type { ProxyActivity } from './activity';
import { getHeaderValue, type HeadersRecord } from './headers';
import {
  describeRule, domainMatches, evaluateProxyPolicy, getRequestScopedManagedItems,
  type PolicyDecision, type RequestFacts, type RequestScopedManagedItem,
} from './policy';
import {
  checkSubstitutionGuards, detectInjectedKeys, findUninjectedPlaceholder, replacePlaceholdersWithReal,
  type SubstitutionGuardRequest,
} from './substitution';
import type {
  ProxyApprovalEach, ProxyEgressMode, ProxyManagedItem, ProxyRule,
} from './types';

/** The policy a proxy enforces, as one swappable snapshot (rules + items + egress mode). */
export type ProxyPolicyState = {
  rules: Array<ProxyRule>;
  managedItems: Array<ProxyManagedItem>;
  egressMode: ProxyEgressMode;
};

export function hostMatchesProxyRules(host: string, rules: Array<ProxyRule>): boolean {
  return rules.some((rule) => rule.domain.some((d) => domainMatches(d, host)));
}

/** Transport-neutral facts about one proxied request (no body — see the two-phase flow below). */
export type ProxiedRequestFacts = {
  host: string;
  /** True when the client's connection to the upstream would be TLS. */
  isHttps: boolean;
  method: string;
  /** Path component for policy facts/activity (no query). */
  pathOnly: string;
  /** Origin-form path+query sent upstream (and scrubbed) — also used as the activity URL. */
  requestTarget: string;
};

/**
 * A request the pipeline refuses to forward. `activity` is the audit event to
 * record; `status`/`message` are the client-facing response. `teardownOnTunnel`
 * mirrors the transport hint historically applied per decision kind: when true,
 * a MITM-tunnel transport should tear the socket down rather than end the
 * response normally (short status-only responses don't reliably flush through a
 * CONNECT tunnel).
 */
export type BlockedOutcome = {
  kind: 'blocked';
  status: number;
  message: string;
  activity: ProxyActivity;
  teardownOnTunnel: boolean;
};

/** Phase-1 result when the request may proceed to body-dependent checks. */
export type PreBodyContinue = {
  kind: 'continue';
  shouldRewrite: boolean;
  /** Managed items in scope for this request (approval-gated keys included only when the approval gate will run). */
  hostItems: Array<RequestScopedManagedItem>;
  policyDecision?: PolicyDecision;
  ruleId?: string;
};

export type ForwardOutcome = {
  kind: 'forward';
  activity: ProxyActivity;
  shouldRewrite: boolean;
  hostItems: Array<RequestScopedManagedItem>;
  /** Keys whose placeholders actually appear in this request (audit detail). */
  injectedKeys: Array<string>;
  /** `requestTarget` with placeholders substituted (identity when not rewriting). */
  rewrittenTarget: string;
  /** Body text with placeholders substituted (identity when not rewriting). */
  rewrittenBodyText: string;
  /** Transform for individual header values (placeholder → real when rewriting, identity otherwise). */
  transformHeaderValue: (value: string) => string;
};

/**
 * Asks the transport's approval provider for an out-of-band, request-bound
 * decision (Invariant #8). Implementations must fail closed (deny on
 * timeout/error); the pipeline additionally treats a thrown error or a missing
 * gate as a denial.
 */
export type ApprovalGateFn = (input: {
  method: string;
  host: string;
  path: string;
  ruleId?: string;
  each?: ProxyApprovalEach;
  maxDurationMs?: number;
  injectedKeys: Array<string>;
}) => Promise<boolean>;

/**
 * Phase 1 of the shared request pipeline — every check that can run before the
 * body is buffered, so a transport can reject a doomed request without reading
 * its body: egress gate → per-call policy (block) → request-scoped item
 * selection → cleartext guard. Returns either a fail-closed `blocked` outcome
 * (the adapter records `activity` and responds with `status`/`message`) or a
 * `continue` carrying the resolved policy context for phase 2.
 */
export function evaluateProxiedRequestPreBody(
  t: ProxiedRequestFacts,
  policy: ProxyPolicyState,
): BlockedOutcome | PreBodyContinue {
  const baseActivity = {
    host: t.host, method: t.method, path: t.pathOnly, url: t.requestTarget,
  };

  const shouldRewrite = hostMatchesProxyRules(t.host, policy.rules);
  const shouldAllowEgress = policy.egressMode === 'permissive' || shouldRewrite;
  if (!shouldAllowEgress) {
    return {
      kind: 'blocked',
      status: 403,
      message: `Blocked by the varlock credential proxy: ${t.host} is not allowed by your egress policy (strict mode only permits hosts with a matching @proxy rule). Add a @proxy rule for this host, or use permissive egress, to allow it.`,
      activity: {
        ...baseActivity, matched: shouldRewrite, blocked: true, decision: 'blocked-egress',
      },
      teardownOnTunnel: false,
    };
  }

  // Per-call policy (static authorization): evaluate host + method + path; a
  // matching `block` rule denies the request and it never reaches upstream.
  const facts: RequestFacts = { host: t.host, method: t.method, path: t.pathOnly };
  const policyDecision = shouldRewrite ? evaluateProxyPolicy(facts, policy.rules, policy.egressMode) : undefined;
  const ruleId = policyDecision?.matchedRule ? describeRule(policyDecision.matchedRule) : undefined;
  if (policyDecision?.verdict === 'deny') {
    // Two deny kinds: an explicit `block` rule (denylist), or strict egress with
    // no allow rule matching this method/path on an otherwise-ruled host.
    const egressStrictDeny = policyDecision.denyKind === 'egress-strict';
    return {
      kind: 'blocked',
      status: 403,
      message: egressStrictDeny
        ? `Blocked by the varlock credential proxy: no @proxy rule matches ${t.method} ${t.host}${t.pathOnly}. `
          + 'The host has a @proxy rule, but none matches this method and path, and egress is strict. '
          + 'Add a matching (or broader) @proxy rule, or use permissive egress.'
        : `Blocked by the varlock credential proxy: a @proxy block rule denies ${t.method} ${t.host}${t.pathOnly}.`,
      activity: {
        ...baseActivity, ...(ruleId ? { ruleId } : {}), matched: true, blocked: true, decision: egressStrictDeny ? 'blocked-egress' : 'deny',
      },
      teardownOnTunnel: true,
    };
  }

  // Approval-gated keys (contributed only by `@proxy(approval)` rules) are
  // withheld unless the verdict actually routes through the approval gate below.
  // A plain-`allow` verdict from a more-specific rule must NOT smuggle a broader
  // approval rule's secret in without a prompt (see getRequestScopedManagedItems).
  const hostItems = shouldRewrite
    ? getRequestScopedManagedItems(facts, policy.rules, policy.managedItems, {
      includeApprovalGatedKeys: policyDecision?.verdict === 'require-approval',
    })
    : [];

  // Invariant #2/#5: never inject a secret into a cleartext (non-TLS) connection —
  // no cert means no verifiable identity. Fail closed. (MITM is always https, so
  // this only fires on the absolute-form http path.)
  if (hostItems.length > 0 && !t.isHttps) {
    return {
      kind: 'blocked',
      status: 403,
      message: `Blocked by the varlock credential proxy: refusing to inject a secret into a cleartext (non-TLS) connection to ${t.host}.`,
      activity: {
        ...baseActivity, ...(ruleId ? { ruleId } : {}), matched: true, blocked: true, decision: 'blocked-cleartext',
      },
      teardownOnTunnel: false,
    };
  }

  return {
    kind: 'continue', shouldRewrite, hostItems, policyDecision, ruleId,
  };
}

/**
 * Phase 2 of the shared request pipeline — the body-dependent checks and the
 * substitution itself: uninjected-placeholder guard → substitution guards
 * (placement + occurrence cap) → approval gate → placeholder → real
 * substitution. Returns a fail-closed `blocked` outcome or a `forward` carrying
 * the rewritten request parts for the transport to send upstream (over a
 * connection whose upstream identity the transport must verify before any
 * secret is written).
 */
export async function evaluateProxiedRequestWithBody(
  pre: PreBodyContinue,
  t: ProxiedRequestFacts,
  policy: ProxyPolicyState,
  input: { headers: HeadersRecord; bodyText: string },
  opts?: { approvalGate?: ApprovalGateFn },
): Promise<BlockedOutcome | ForwardOutcome> {
  const {
    shouldRewrite, hostItems, policyDecision, ruleId,
  } = pre;
  const baseActivity = {
    host: t.host, method: t.method, path: t.pathOnly, url: t.requestTarget,
  };
  const ruleIdPart = ruleId ? { ruleId } : {};

  const scanParts = [t.requestTarget, JSON.stringify(input.headers), input.bodyText];
  const injectedKeys = shouldRewrite ? detectInjectedKeys(scanParts, hostItems) : [];

  // Helpful-failure guard: when NO rule injects anything on this route yet the
  // request carries a managed placeholder, the real value won't be substituted
  // and the upstream would reject it with a cryptic auth error — and the cause
  // is the proxy rules (wrong path/method, or wrong host). Explain it instead of
  // forwarding a doomed request. Scoped to `hostItems.length === 0` so a request
  // that DOES inject on this route can still carry an unrelated placeholder
  // (e.g. another item's, bound for a different host) through untouched.
  const leaked = hostItems.length === 0
    ? findUninjectedPlaceholder(scanParts, policy.managedItems, hostItems)
    : undefined;
  if (leaked) {
    return {
      kind: 'blocked',
      status: 403,
      message: `Blocked by the varlock credential proxy: this request to ${t.host}${t.pathOnly} carries the placeholder for ${leaked.key}, `
        + 'but no @proxy rule injects it here — the real value was not substituted and the request would fail upstream. '
        + 'Add or broaden a @proxy rule so it matches this request (host + path + method).',
      activity: {
        ...baseActivity, ...ruleIdPart, matched: shouldRewrite, blocked: true, decision: 'blocked-uninjected',
      },
      teardownOnTunnel: true,
    };
  }

  // Substitution guards: before any placeholder is swapped for its real value,
  // enforce *where* (target: header / header:name / query:param / body:path) and
  // *how often* (occurrence cap) each injected secret may appear. Default is any
  // header, once. This is what keeps a clever request from moving the real secret
  // into an exfiltration-friendly spot (an email body, a duplicated field) on an
  // otherwise-allowed host — the secret is only ever substituted where the rule
  // explicitly allows.
  if (shouldRewrite && hostItems.length > 0) {
    const guardReq: SubstitutionGuardRequest = {
      headers: Object.entries(input.headers).map(([name, value]) => ({
        name: name.toLowerCase(),
        value: Array.isArray(value) ? value.join('\n') : String(value ?? ''),
      })),
      requestTarget: t.requestTarget,
      body: input.bodyText,
      contentType: getHeaderValue(input.headers, 'content-type'),
    };
    const violation = checkSubstitutionGuards(guardReq, hostItems);
    if (violation) {
      const decision = violation.kind === 'location' ? 'blocked-location' : 'blocked-occurrences';
      return {
        kind: 'blocked',
        status: 403,
        message: violation.kind === 'location'
          ? `Blocked by the varlock credential proxy: ${violation.item.key}'s placeholder appears in the ${violation.location} of this request, which its @proxy rule doesn't allow. `
            + `${violation.suggestion}. `
            + 'If that placement was not intentional, it may be an attempt to place the secret somewhere it could leak.'
          : `Blocked by the varlock credential proxy: ${violation.item.key}'s placeholder appears ${violation.count} times in this request, but at most ${violation.item.maxOccurrences} is allowed. `
            + 'A valid request uses the secret once; extra copies can exfiltrate it. If this API legitimately repeats it, raise maxOccurrences on the @proxy rule.',
        activity: {
          ...baseActivity, ...ruleIdPart, matched: true, blocked: true, decision,
        },
        teardownOnTunnel: true,
      };
    }
  }

  // Invariant #8: a require-approval rule holds the request for an out-of-band,
  // request-bound decision. Fail closed (deny) unless explicitly approved: a
  // missing gate or a throwing gate is a denial.
  if (policyDecision?.verdict === 'require-approval') {
    let approved = false;
    if (opts?.approvalGate) {
      try {
        approved = await opts.approvalGate({
          method: t.method,
          host: t.host,
          path: t.pathOnly,
          ruleId,
          each: policyDecision.matchedRule?.approval?.each,
          maxDurationMs: policyDecision.matchedRule?.approval?.maxDurationMs,
          injectedKeys,
        });
      } catch {
        approved = false;
      }
    }
    if (!approved) {
      return {
        kind: 'blocked',
        status: 403,
        message: `Blocked by the varlock credential proxy: this request to ${t.host} required approval and it was not granted.`,
        activity: {
          ...baseActivity, ...ruleIdPart, matched: true, blocked: true, decision: 'approval-denied',
        },
        teardownOnTunnel: true,
      };
    }
  }

  // Substitute placeholder → real value. The guards above already proved every
  // occurrence sits at an allowed target for its item, and placeholders are unique
  // per item, so a blind string-replace across all three parts only ever hits the
  // approved spot — no need to re-scope per location (which would also risk
  // re-serializing/altering the body).
  return {
    kind: 'forward',
    activity: {
      ...baseActivity,
      ...ruleIdPart,
      matched: shouldRewrite,
      blocked: false,
      decision: policyDecision?.verdict === 'require-approval' ? 'approval-granted' : 'allow',
      ...(injectedKeys.length ? { injectedKeys } : {}),
    },
    shouldRewrite,
    hostItems,
    injectedKeys,
    rewrittenTarget: shouldRewrite
      ? replacePlaceholdersWithReal(t.requestTarget, hostItems)
      : t.requestTarget,
    rewrittenBodyText: shouldRewrite
      ? replacePlaceholdersWithReal(input.bodyText, hostItems)
      : input.bodyText,
    transformHeaderValue: shouldRewrite
      ? (value) => replacePlaceholdersWithReal(value, hostItems)
      : (value) => value,
  };
}
