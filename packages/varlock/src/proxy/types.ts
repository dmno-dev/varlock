export type ProxyEgressMode = 'permissive' | 'strict';

export type ProxyRuleSource = 'attached' | 'detached';

/**
 * Approval granularity — what a single approval (and any standing grant) covers.
 * `host` = the host; `endpoint` = method + path; `request` = method + path + body.
 */
export type ProxyApprovalEach = 'host' | 'endpoint' | 'request';

export const PROXY_APPROVAL_EACH_VALUES: ReadonlyArray<ProxyApprovalEach> = ['host', 'endpoint', 'request'];

export type ProxyRule = {
  source: ProxyRuleSource;
  domain: Array<string>;
  itemKeys: Array<string>;
  path?: string;
  method?: string;
  block?: boolean;
  /** Require out-of-band approval before this request is forwarded (Invariant #8). */
  approval?: boolean;
  /** Granularity of approvals / standing grants. Default `endpoint`. */
  approvalEach?: ProxyApprovalEach;
  /**
   * Ceiling on how long a "yes" may be remembered, in ms — the schema-enforced
   * cap on grant lifetime. `0` = always ask (never remembered); `undefined` =
   * may persist for the whole session.
   */
  approvalMaxDurationMs?: number;
};

export type ProxyManagedItem = {
  key: string;
  placeholder: string;
  realValue: string;
  /** True when the placeholder is the generic format-agnostic fallback (may fail SDK key-format checks). */
  placeholderIsGenericFallback?: boolean;
};
