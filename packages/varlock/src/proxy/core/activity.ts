/** The security decision the proxy reached for a single request. */
export type ProxyAuditDecision = | 'allow' // forwarded upstream (a secret may or may not have been injected)
  | 'deny' // matched a `block` rule — never reached upstream
  | 'blocked-egress' // strict egress mode rejected a non-allowlisted host
  | 'blocked-uninjected' // request carried a placeholder no rule injects on this route (misconfig)
  | 'blocked-cleartext' // refused to inject a secret into a non-TLS connection
  | 'blocked-location' // placeholder appeared in a request location the rule doesn't allow substituting in
  | 'blocked-occurrences' // placeholder appeared more times than the rule's occurrence cap allows
  | 'approval-granted' // require-approval rule matched and the approver allowed it
  | 'approval-denied'; // require-approval rule matched and approval was denied/timed-out

/**
 * Structured per-request activity emitted by the proxy runtime. It carries
 * everything the audit log needs but **never** a secret value: `path`/`url` are
 * the child's *placeholder-form* request (injection happens after this is
 * emitted), and `injectedKeys` are item keys (names), not values.
 */
export type ProxyActivity = {
  /** Whether the host matched a configured `@proxy` rule. */
  matched: boolean;
  /** Whether the request was blocked (egress, policy, or cleartext guard). */
  blocked: boolean;
  host: string;
  method: string;
  /** Path only, no query string, in placeholder form. */
  path: string;
  /** Full path + query in placeholder form — used only to compute the fingerprint hash. */
  url?: string;
  decision: ProxyAuditDecision;
  /** Stable descriptor of the matched rule (see `describeRule`), if any. */
  ruleId?: string;
  /** Keys (names, never values) of the managed items actually injected into this request. */
  injectedKeys?: Array<string>;
};
