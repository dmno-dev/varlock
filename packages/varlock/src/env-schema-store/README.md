# Environment Schema Store

## Quick Start (Experimental Feature)

The Environment Schema Store is currently an experimental feature. To enable it:

### Option 1: Environment Variable (Recommended)
```bash
# Enable globally
export VARLOCK_SCHEMA_STORE=true

# Run doctor with schema validation
varlock doctor
```

### Option 2: Command Flag
```bash
# Enable for a single command
varlock doctor --schema-store
```

### Option 3: In your .env file
```env
# Enable schema store for this project
# @schema-store enabled
```

## What It Does

When enabled, the Environment Schema Store:

1. **Auto-discovers** schemas from your installed packages
2. **Validates** your environment variables
3. **Reports** missing required variables
4. **Suggests** improvements

## Example

```bash
# With @sentry/nextjs and stripe installed:
$ VARLOCK_SCHEMA_STORE=true varlock doctor

Environment Schema Validation (Experimental):
  Found 2 schema(s):
    - sentry 8.0.0 (auto-discovered)
    - stripe 13.0.0 (auto-discovered)
  
  ❌ Missing Required Variables:
    ❌ SENTRY_DSN: Your Sentry DSN for error tracking
    ❌ STRIPE_SECRET_KEY: Stripe secret key (server-side only)
```

## Supported Packages

Currently includes schemas for 30+ popular packages:
- **AI**: OpenAI, Anthropic, Gemini
- **Auth**: Clerk, Auth0
- **Database**: PostgreSQL, Redis, Prisma, Supabase, Drizzle, Convex, Neon
- **Monitoring**: Sentry, Datadog, PostHog, Statsig
- **Payments**: Stripe
- **Communication**: Twilio, Slack
- **Deployment**: Vercel, Cloudflare Workers
- **Frameworks**: Expo, Hono

## Configuration

Control schema behavior in your `.env`:

```env
# Load specific schemas
# @load sentry@8.0.0
# @load stripe(nextjs)

# Exclude schemas
# @exclude prisma

# Override priorities
# @override SENTRY_DEBUG optional
```

## Contributing

Add new schemas in `env-schema-store/schemas/`. See [CONTRIBUTING.md](../../env-schema-store/CONTRIBUTING.md) for guidelines.

## Feedback

This is an experimental feature. Please report issues and suggestions at:
https://github.com/dmno-dev/varlock/issues