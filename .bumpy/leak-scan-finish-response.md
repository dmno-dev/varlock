---
varlock: patch
---

A leak detected in `ServerResponse.end` no longer leaves the HTTP client hanging. The response is finished with a plaintext 500 (or the socket is destroyed if headers were already sent) before the leak error is rethrown, so a Next.js Pages Router `res.json()` that would have leaked a sensitive value now returns instead of stalling.
