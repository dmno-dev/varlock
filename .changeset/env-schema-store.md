---
"@varlock/mcp-env-schema-generator": minor
"@env-spec/parser": patch
"varlock": minor
---

feat: Add Environment Schema Store for zero-config validation

## 🎯 Key Features

### Environment Schema Store
- **Auto-discovery**: Automatically discovers and applies schemas based on package.json dependencies
- **30+ Pre-built Schemas**: Comprehensive schemas for popular services including:
  - AI providers (OpenAI, Anthropic, Gemini)
  - Databases (Supabase, PostgreSQL, MongoDB, Drizzle, Convex, Neon)
  - Monitoring (Sentry, Datadog, PostHog, Statsig)
  - Frameworks (Next.js, Vite, Astro, Expo, Hono, Cloudflare Workers)
  - Cloud providers (AWS, GCP, Azure, Vercel)
  - Communication (Twilio, Slack, Notion, Pusher, Ably, Stream)
  - And many more...

### Enhanced MCP Server
- **AI-Powered Schema Generation**: Automatically generates env schemas using AI SDK
- **Multi-Provider Support**: Works with OpenAI, Anthropic, and Gemini
- **Intelligent Analysis**: Combines regex parsing with AI understanding for accurate schemas

### Developer Experience
- **Zero Configuration**: Works out of the box with existing projects
- **Version-Aware**: Applies appropriate schemas based on package versions
- **Framework Detection**: Automatically detects and applies framework-specific patterns
- **Smart Caching**: 24-hour cache for optimal performance
- **API Endpoints**: REST API for validation, discovery, and catalog access

### Safety & Adoption
- **Opt-in Feature**: Disabled by default, enable with `VARLOCK_SCHEMA_STORE=true`
- **Backward Compatible**: No breaking changes to existing functionality
- **Telemetry Integration**: Anonymous usage statistics for improving schemas

This feature significantly improves the developer experience by providing instant, accurate environment variable validation without any configuration needed.