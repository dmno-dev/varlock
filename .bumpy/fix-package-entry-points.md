---
varlock: patch
"@env-spec/parser": patch
"@varlock/ci-env-info": patch
"@varlock/astro-integration": patch
"@varlock/cloudflare-integration": patch
"@varlock/nextjs-integration": patch
"@varlock/vite-integration": patch
"@varlock/1password-plugin": patch
"@varlock/akeyless-plugin": patch
"@varlock/aws-secrets-plugin": patch
"@varlock/azure-key-vault-plugin": patch
"@varlock/bitwarden-plugin": patch
"@varlock/dashlane-plugin": patch
"@varlock/doppler-plugin": patch
"@varlock/google-secret-manager-plugin": patch
"@varlock/hashicorp-vault-plugin": patch
"@varlock/infisical-plugin": patch
"@varlock/keeper-plugin": patch
"@varlock/kubernetes-plugin": patch
"@varlock/pass-plugin": patch
"@varlock/passbolt-plugin": patch
"@varlock/proton-pass-plugin": patch
---

Fix package.json entry points - remove references to files that were never built and declare import/require conditions explicitly
