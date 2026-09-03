---
varlock: patch
---

A leak detected in `ServerResponse.end` no longer leaves the HTTP client hanging. The connection is now closed before the leak error is rethrown, so a Next.js Pages Router `res.json()` that would have leaked a sensitive value fails the request instead of stalling the client on a body that never arrives.
