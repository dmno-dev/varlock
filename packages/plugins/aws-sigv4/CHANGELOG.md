# Changelog

## 0.1.0
<sub>2026-09-04</sub>

- [#1008](https://github.com/dmno-dev/varlock/pull/1008)  *(minor)*
  Initial release: adds the aws-sigv4 request-signing scheme to the credential proxy. The agent's AWS SDK signs with placeholder credentials; the proxy re-signs with the real keys, deriving region/service from the request, with optional region/service allowlists.
