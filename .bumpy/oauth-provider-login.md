---
varlock: minor
env-spec-language: patch
---

New @oauthProvider root decorator (with presets for google, github, microsoft, slack) and varlock oauth login/status commands: define an OAuth provider once, provision a refresh token via a browser or device-code login flow, and mint access tokens from it with oauth() without storing a refresh token anywhere
