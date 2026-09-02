---
"@varlock/aws-sigv4-plugin": minor
---

Initial release: adds the aws-sigv4 request-signing scheme to the credential proxy. The agent's AWS SDK signs with placeholder credentials; the proxy re-signs with the real keys, deriving region/service from the request, with optional region/service allowlists.
