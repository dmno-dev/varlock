---
varlock: patch
---

`varlock proxy`: `@proxy(path=...)` rules are now matched against the canonical request path (dot segments resolved, repeated slashes collapsed, unreserved percent-escapes decoded), and that canonical path is what is sent upstream. Previously a request spelled `/v1/charges/../refunds/x` did not match a `path="/v1/refunds/**"` block rule even though the upstream routed it to `/v1/refunds/x`. Paths that cannot be canonicalized unambiguously (encoded slashes, backslashes, control characters, `#`, `;` path parameters, `..` above the root, absolute-form request lines inside a tunnel) are now rejected with a 400. A `substituteIn=[path]` value that would itself change the path structure (contains a path separator, dot segment, or query marker) is refused instead of routing the request somewhere the rules never evaluated.
