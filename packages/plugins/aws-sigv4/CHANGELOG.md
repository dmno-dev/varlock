# Changelog


## 0.1.1
<sub>2026-09-25</sub>

- [#1114](https://github.com/dmno-dev/varlock/pull/1114)  *(patch)*
  Build the plugin as a single file. The split chunks re-ran the plugin outside of its context, so `gsm()` failed every call with "No active plugin context" (aws-secrets, aws-sigv4 and infisical could hit the same error on some code paths)

## 0.1.0
<sub>2026-09-12</sub>

- [#1008](https://github.com/dmno-dev/varlock/pull/1008)  *(minor)*
  Initial release: adds the aws-sigv4 request-signing scheme to the credential proxy. The agent's AWS SDK signs with placeholder credentials; the proxy re-signs with the real keys, deriving region/service from the request, with optional region/service allowlists.
