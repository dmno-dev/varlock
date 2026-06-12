---
"@env-spec/parser": minor
varlock: minor
---

Add per-item leak-detection opt-out via `@sensitive={preventLeaks=false}`. Secrets that legitimately leave the system (e.g. an API endpoint that returns a secret to another service) can be excluded from runtime leak detection while still being redacted in logs.

Adds standalone object (`{key=value}`) and array (`[a, b, c]`) literals to the env-spec grammar, usable as decorator values and function-call arguments (including nested). `()` remains reserved for function calls.
