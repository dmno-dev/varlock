---
varlock: patch
---

A leak detected in `ServerResponse.end` no longer leaves the HTTP client hanging. The response is finished before the leak error is rethrown (a plaintext 500 if the headers have not gone out yet, otherwise the connection is closed), so a Next.js Pages Router `res.json()` that would have leaked a sensitive value fails the request instead of stalling the client on a body that never arrives.
