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
};

export type ProxyManagedItem = {
  key: string;
  placeholder: string;
  realValue: string;
  /** True when the placeholder is the generic format-agnostic fallback (may fail SDK key-format checks). */
  placeholderIsGenericFallback?: boolean;
};
