---
"varlock": minor
---

Add remote import support for `@import()` decorator with two new protocols:

- `public-schemas:` - Import pre-built schemas for popular platforms (Vercel, Netlify, Cloudflare) from the varlock repository, with local caching
- `plugin-schema:` - Import schema files from installed plugin packages, with support for loading specific files (e.g., `plugin-schema:@varlock/1password-plugin/.env.connect`)

Also adds:
- `varlock cache clear` CLI command to manage cached schemas and plugins
- Security restrictions for remote imports (no plugin installation, no local file access)
- Public schemas for Vercel, Netlify, Cloudflare Pages, and Cloudflare Wrangler
- Graceful fallback to temp directory when user home directory is unavailable
