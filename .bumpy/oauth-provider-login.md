---
varlock: minor
env-spec-language: patch
---

New @oauthClient root decorator (with built-in provider defs for google, github, microsoft, slack) and varlock oauth login/status commands: define an OAuth client once, provision a refresh token via a browser or device-code login flow, and mint access tokens from it with oauth() without storing a refresh token anywhere
