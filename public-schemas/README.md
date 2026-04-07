# Public Schemas

This directory contains pre-built `.env` schema files that can be imported into any project using the `public-schemas:` import protocol.

## Usage

Import a public schema in your `.env.schema` file:

```env-spec
# @import(public-schemas:platforms/vercel)
```

This will fetch and cache the schema from the varlock repository on GitHub.

## Available Schemas

### Platforms

- **`platforms/vercel`** - Vercel system environment variables
- **`platforms/netlify`** - Netlify build environment variables
- **`platforms/cloudflare-pages`** - Cloudflare Pages build environment variables
- **`platforms/cloudflare-wrangler`** - Cloudflare Wrangler system environment variables

## Contributing

To add a new public schema:

1. Create a `.env.<name>` file in the appropriate subdirectory
2. Follow the existing format using `@env-spec` decorators
3. Include documentation links with `@docs()` decorators
4. Mark all items as `@optional` (since they're platform-injected)
5. Mark sensitive items with `@sensitive`
