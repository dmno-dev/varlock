---
varlock: patch
---

`varlock proxy`: `@proxy(path=...)` rules are now matched against the canonical request path (dot segments resolved, repeated slashes collapsed, unreserved percent-escapes decoded), and that canonical path is what is sent upstream. Previously a request spelled `/v1/charges/../refunds/x` did not match a `path="/v1/refunds/**"` block rule even though the upstream routed it to `/v1/refunds/x`. Paths that cannot be canonicalized unambiguously (encoded slashes, backslashes, control characters, `..` above the root, absolute-form request lines inside a tunnel) are now rejected with a 400.
