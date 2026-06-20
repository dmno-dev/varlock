---
varlock: patch
---

`varlock proxy start` now prints a live request log to its terminal.

Each proxied request shows a color-coded one-line decision with the keys injected
on the way out, and each forwarded response shows its status and any keys scrubbed
back to placeholders on the way in (`→` green / `✗` red request, `←` cyan response,
status colored by class, injected/scrubbed key names highlighted):

```
→ GET httpbin.org/get  inject: API_TOKEN
← GET httpbin.org/get  200  scrubbed: API_TOKEN
✗ GET example.com/  blocked-egress
```
