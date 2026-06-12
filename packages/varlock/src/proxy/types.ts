export type ProxyEgressMode = 'permissive' | 'strict';

export type ProxyRuleSource = 'attached' | 'detached';

export type ProxyRule = {
  source: ProxyRuleSource;
  domain: Array<string>;
  itemKeys: Array<string>;
  path?: string;
  method?: string;
  block?: boolean;
  sign?: string;
  transform?: string;
  /**
   * Optional per-rule certificate pinning (Invariant #4). Expected upstream
   * cert SHA-256 fingerprints; if set, the upstream cert must match one of them
   * in addition to validating against the public PKI. Closes the residual hole
   * where any mis-issued-but-publicly-trusted cert would otherwise pass.
   */
  pin?: Array<string>;
};

export type ProxyManagedItem = {
  key: string;
  placeholder: string;
  realValue: string;
  /** True when the placeholder is the generic format-agnostic fallback (may fail SDK key-format checks). */
  placeholderIsGenericFallback?: boolean;
};
