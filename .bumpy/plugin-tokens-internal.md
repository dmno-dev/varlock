---
"@varlock/1password-plugin": major
"@varlock/akeyless-plugin": major
"@varlock/bitwarden-plugin": major
"@varlock/dashlane-plugin": major
"@varlock/doppler-plugin": major
"@varlock/hashicorp-vault-plugin": major
"@varlock/infisical-plugin": major
"@varlock/keepass-plugin": major
"@varlock/keeper-plugin": major
"@varlock/passbolt-plugin": major
"@varlock/proton-pass-plugin": major
"@varlock/kubernetes-plugin": major
---

**Breaking:** the service-account / auth token data types are now `@internal` by default — varlock still uses them to fetch your other secrets, but they are no longer injected into your application. If your app reads one of these credentials directly (e.g. to write secrets back or fetch more at runtime), set `@internal=false` to keep it injected.
