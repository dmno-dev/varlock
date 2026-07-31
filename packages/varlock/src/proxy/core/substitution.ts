import type { RequestScopedManagedItem } from './policy';
import {
  isNeverAutoSubstituteHeader, proxySubstitutionTargetKey,
  type ProxyManagedItem, type ProxySubstitutionLocation, type ProxySubstitutionTarget,
} from './types';

/**
 * Number of non-overlapping occurrences of `needle` in `haystack`. Uses an
 * indexOf scan rather than `split` so it stays O(n) time / O(1) extra space: an
 * untrusted agent controls the request and could repeat a placeholder many times,
 * and `split` would allocate an array proportional to the match count.
 */
export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/** A request decomposed into the parts the substitution guards inspect. */
export type SubstitutionGuardRequest = {
  /** Header name (lower-cased) + value, one entry per header. */
  headers: Array<{ name: string; value: string }>;
  /** Request target: path + query string. */
  requestTarget: string;
  /** Raw request body text. */
  body: string;
  /** Content-type header value, if any (selects the body parser). */
  contentType?: string;
};

export type SubstitutionGuardViolation = | { kind: 'location'; item: RequestScopedManagedItem; location: ProxySubstitutionLocation; suggestion: string }
  | { kind: 'occurrences'; item: RequestScopedManagedItem; count: number };

/** A string value in a request body, with the dotted path that locates it. */
type BodyLeaf = { path: string; value: string };

/**
 * String leaves of a request body, each with its dotted path, so a body-path
 * target can be checked. JSON objects/arrays produce paths like `client_secret`,
 * `data.token`, `items[0].key`; form bodies produce one leaf per field (path =
 * field name). Returns null when the body can't be parsed for the content type —
 * the guard treats that as "no allowed body occurrences" and fails closed.
 */
function bodyStringLeaves(body: string, contentType: string | undefined): Array<BodyLeaf> | null {
  const ct = (contentType ?? '').toLowerCase();
  if (ct.includes('application/x-www-form-urlencoded')) {
    return [...new URLSearchParams(body)].map(([name, value]) => ({ path: name, value }));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const out: Array<BodyLeaf> = [];
  const walk = (node: unknown, prefix: string) => {
    if (typeof node === 'string') {
      out.push({ path: prefix, value: node });
    } else if (Array.isArray(node)) {
      node.forEach((el, i) => walk(el, `${prefix}[${i}]`));
    } else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) walk(v, prefix ? `${prefix}.${k}` : k);
    }
    // numbers/booleans/null can't contain a placeholder string — skip.
  };
  walk(parsed, '');
  return out;
}

/** A copy-pasteable `substituteIn=[...]` that keeps the current targets and adds `entry`. */
function substituteInExample(targets: Array<ProxySubstitutionTarget>, entry: string): string {
  return `substituteIn=[${[...targets.map(proxySubstitutionTargetKey), entry].join(', ')}]`;
}

/** Human hint naming the current targets and the exact substituteIn edit to allow the offending location. */
function locationSuggestion(location: ProxySubstitutionLocation, targets: Array<ProxySubstitutionTarget>): string {
  const current = targets.map(proxySubstitutionTargetKey);
  const entry = location === 'body' ? 'body:<path>' : location;
  const extraByLocation: Partial<Record<ProxySubstitutionLocation, string>> = {
    body: ' (name the field, e.g. body:client_secret, or body:* to allow anywhere in the body)',
    query: ' (or query:<param> to pin one parameter)',
  };
  const extra = extraByLocation[location] ?? '';
  return `currently allowed: [${current.join(', ')}]. To allow it in the ${location}, set ${substituteInExample(targets, entry)} on the @proxy rule${extra}`;
}

/** Header-specific hint: names the offending header, the exact substituteIn edit, and any denylist note. */
function headerSuggestion(name: string | undefined, denied: boolean, targets: Array<ProxySubstitutionTarget>): string {
  const current = targets.map(proxySubstitutionTargetKey);
  const where = name ? `the "${name}" header` : 'that header';
  const entry = name ? `header:${name}` : 'header:<name>';
  const deniedNote = denied
    ? ` (${name} is excluded from the any-header default because it's commonly forwarded or logged)`
    : '';
  return `currently allowed: [${current.join(', ')}]${deniedNote}. To allow it in ${where}, set ${substituteInExample(targets, entry)} on the @proxy rule`;
}

/**
 * Enforce the substitution guards on the injected items for a request, *before*
 * any placeholder is swapped for its real value. Returns the first violation, or
 * undefined if every injected placeholder sits only where its rule allows and
 * within its occurrence cap.
 *
 *  - placement guard: a placeholder occurrence anywhere the item's `targets` don't
 *    allow is an anomaly (default: any header). Each occurrence is checked against
 *    the exact target (specific header name, query param, or body path), which is
 *    what stops an injected secret from being swapped into a request body/query — a
 *    placeholder the agent was tricked into placing in, say, an email body on an
 *    otherwise-allowed host, even one whose body IS a substitution target at a
 *    different path.
 *  - cardinality guard: a valid request uses the secret a fixed number of times
 *    (default 1). An extra occurrence suggests an exfiltration copy (duplicate the
 *    token into an attacker-visible field while still making a valid call).
 *
 * Because placeholders are unique high-entropy tokens, the guard alone decides
 * placement; the actual substitution can stay a blind string-replace, since a
 * passing request has every occurrence at an allowed spot.
 *
 * Both fail closed: the caller blocks the request rather than substituting.
 */
export function checkSubstitutionGuards(
  req: SubstitutionGuardRequest,
  hostItems: Array<RequestScopedManagedItem>,
): SubstitutionGuardViolation | undefined {
  for (const item of hostItems) {
    const ph = item.placeholder;
    if (!ph) continue;
    const { targets } = item;
    const anyHeader = targets.some((t) => t.location === 'header' && !t.name);
    const headerNames = new Set(targets.flatMap((t) => (t.location === 'header' && t.name ? [t.name] : [])));
    const anyPath = targets.some((t) => t.location === 'path');
    const anyQuery = targets.some((t) => t.location === 'query' && !t.name);
    const queryNames = targets.flatMap((t) => (t.location === 'query' && t.name ? [t.name] : []));
    const bodyPaths = targets.flatMap((t) => (t.location === 'body' ? [t.path] : []));
    // `body:*` is the explicit escape hatch for bodies we can't parse into a path.
    const bodyAnywhere = bodyPaths.includes('*');

    // Split the request target into the URL path and the query string: they are
    // separate substitution locations (`path` vs `query`/`query:<param>`).
    const queryStart = req.requestTarget.indexOf('?');
    const pathPart = queryStart === -1 ? req.requestTarget : req.requestTarget.slice(0, queryStart);
    const queryPart = queryStart === -1 ? '' : req.requestTarget.slice(queryStart + 1);

    // Headers: total occurrences vs. those in an allowed header. The any-header
    // default excludes a denylist of never-secret forward/log headers; an explicit
    // header:<name> target still wins (so a named denied header is allowed).
    let headerTotal = 0;
    let headerAllowed = 0;
    let offendingHeader: string | undefined;
    for (const h of req.headers) {
      const c = countOccurrences(h.value, ph);
      if (!c) continue;
      headerTotal += c;
      const allowed = headerNames.has(h.name) || (anyHeader && !isNeverAutoSubstituteHeader(h.name));
      if (allowed) headerAllowed += c;
      else offendingHeader ||= h.name;
    }
    if (headerAllowed < headerTotal) {
      const denied = anyHeader && !!offendingHeader && isNeverAutoSubstituteHeader(offendingHeader);
      return {
        kind: 'location', item, location: 'header', suggestion: headerSuggestion(offendingHeader, denied, targets),
      };
    }

    // URL path: all-or-nothing (`path` allows a token anywhere in the path).
    const pathTotal = countOccurrences(pathPart, ph);
    if (pathTotal > 0 && !anyPath) {
      return {
        kind: 'location', item, location: 'path', suggestion: locationSuggestion('path', targets),
      };
    }

    // Query string: total occurrences vs. those in an allowed param.
    const queryTotal = countOccurrences(queryPart, ph);
    let queryAllowed = 0;
    if (queryTotal) {
      if (anyQuery) {
        queryAllowed = queryTotal;
      } else if (queryNames.length) {
        const params = new URLSearchParams(queryPart);
        for (const name of queryNames) for (const v of params.getAll(name)) queryAllowed += countOccurrences(v, ph);
      }
    }
    if (queryAllowed < queryTotal) {
      return {
        kind: 'location', item, location: 'query', suggestion: locationSuggestion('query', targets),
      };
    }

    // Body: total occurrences vs. those at an allowed path. `body:*` allows anywhere
    // (no parse needed); otherwise an unparseable body (leaves === null) allows
    // nothing, so a `body:<path>` target fails closed on a body we can't parse.
    const bodyTotal = countOccurrences(req.body, ph);
    let bodyAllowed = 0;
    if (bodyTotal && bodyAnywhere) {
      bodyAllowed = bodyTotal;
    } else if (bodyTotal && bodyPaths.length) {
      const leaves = bodyStringLeaves(req.body, req.contentType);
      if (leaves) {
        for (const leaf of leaves) if (bodyPaths.includes(leaf.path)) bodyAllowed += countOccurrences(leaf.value, ph);
      }
    }
    if (bodyAllowed < bodyTotal) {
      return {
        kind: 'location', item, location: 'body', suggestion: locationSuggestion('body', targets),
      };
    }

    const total = headerTotal + pathTotal + queryTotal + bodyTotal;
    if (total > item.maxOccurrences) return { kind: 'occurrences', item, count: total };
  }
  return undefined;
}

export function replacePlaceholdersWithReal(value: string, managedItems: Array<ProxyManagedItem>): string {
  let next = value;
  // Longest placeholder first, mirroring the scrub direction: if one placeholder
  // is a substring of another (e.g. `vlk_x` and `vlk_x_1`), replacing the shorter
  // one first would corrupt the longer one and splice in the wrong real value.
  const sortedByPlaceholderLength = [...managedItems]
    .filter((item) => !!item.placeholder)
    .sort((a, b) => b.placeholder.length - a.placeholder.length);
  for (const item of sortedByPlaceholderLength) {
    next = next.split(item.placeholder).join(item.realValue);
  }
  return next;
}

/**
 * Which managed items' placeholders actually appear in this request — i.e. the
 * secrets that will really be injected. Used for the audit log so it records
 * what was injected (keys only), not merely what was in scope.
 */
export function detectInjectedKeys(parts: Array<string>, hostItems: Array<ProxyManagedItem>): Array<string> {
  const keys: Array<string> = [];
  for (const item of hostItems) {
    if (!item.placeholder) continue;
    if (parts.some((part) => part.includes(item.placeholder))) keys.push(item.key);
  }
  return keys;
}

/**
 * Find a managed placeholder present in the outbound request that is NOT being
 * injected on this route (`injectHere`). Such a placeholder would reach the
 * upstream un-substituted and fail with a cryptic auth error, and the cause is
 * the proxy rules (wrong path/method, or wrong host) — so we catch it and
 * explain, rather than forwarding a doomed request. Placeholders are unique
 * per item, so a match is unambiguous (no false positives).
 */
export function findUninjectedPlaceholder(
  parts: Array<string>,
  managedItems: Array<ProxyManagedItem>,
  injectHere: Array<ProxyManagedItem>,
): ProxyManagedItem | undefined {
  const injectedKeys = new Set(injectHere.map((item) => item.key));
  return managedItems.find(
    (item) => item.placeholder.length > 0
      && !injectedKeys.has(item.key)
      && parts.some((part) => part.includes(item.placeholder)),
  );
}

export function replaceRealWithPlaceholders(value: string, managedItems: Array<ProxyManagedItem>): string {
  let next = value;
  const sortedByRealLength = [...managedItems]
    .filter((item) => !!item.realValue && !!item.placeholder)
    .sort((a, b) => b.realValue.length - a.realValue.length);
  for (const item of sortedByRealLength) {
    next = next.split(item.realValue).join(item.placeholder);
  }
  return next;
}
