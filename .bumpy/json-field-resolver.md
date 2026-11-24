---
"varlock": minor
---

Add a `jsonField(source, path)` resolver that picks one field out of a JSON value, such as `jsonField(exec(\`my-cli export --format=json\`), "AccessKeyId")`. Nested fields use dot-separated paths.
