# Environment Schema Store

> A centralized, community-driven registry of environment variable schemas for popular packages and services.

## Overview

The Environment Schema Store provides pre-built `.env` schemas using the `@env-spec` decorator syntax, enabling:

- **Zero-configuration validation** for environment variables
- **Auto-discovery** of required environment variables from installed packages
- **Type safety and IDE support** for environment configuration
- **Security best practices** with sensitive value detection and redaction
- **Framework-specific schemas** (Next.js, Vite, Astro, etc.)

## Key Features

### 🚀 Auto-Discovery
Automatically loads schemas based on your `package.json` dependencies. No configuration needed!

### 📦 Package Versioning
Schemas are versioned to match package releases, ensuring compatibility.

### 🔒 Security First
- Automatic detection of sensitive values
- Built-in redaction for logs
- Leak prevention in runtime

### 🎯 Framework Aware
Different environment variable names for different frameworks are handled automatically.

### ⚡ Performance Optimized
- Caching of schema resolution
- Lazy loading of schemas
- Minimal runtime overhead

## How It Works

1. **Detection**: Varlock scans your `package.json` for known packages
2. **Loading**: Relevant schemas are automatically loaded from the store
3. **Validation**: Your `.env` file is validated against the combined schemas
4. **Type Generation**: TypeScript types are generated for your environment

## Schema Format

Schemas use the `@env-spec` decorator syntax with additional metadata:

```env
# @package sentry
# @version ^8.0.0
# @framework nextjs, vite

# @required @secret
# @desc Your Sentry DSN for error tracking
SENTRY_DSN=

# @optional @public
# @desc Environment name for Sentry (defaults to NODE_ENV)
# @default process.env.NODE_ENV
SENTRY_ENVIRONMENT=

# @suggested @public
# @desc Release version for Sentry
# @example 1.0.0
SENTRY_RELEASE=
```

## Priority Levels

Variables can be marked with three priority levels:

- **@required**: Must be set for the application to function
- **@optional**: Can be omitted without breaking functionality
- **@suggested**: Recommended for optimal experience but not essential

## Configuration

Control schema loading behavior in your `.env` file:

```env
# Load specific schemas explicitly
# @load sentry@8.0.0
# @load stripe(nextjs)

# Exclude auto-discovered schemas
# @exclude prisma

# Override specific variables
# @override SENTRY_DSN optional

# Disable auto-discovery entirely
# @schema-store auto-discovery=false
```

## Contributing

We welcome contributions! See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines on:
- Adding new schemas
- Testing schemas
- Schema formatting standards
- Version management

## API

### Validation Endpoint
```
POST /api/validate
Content-Type: application/json

{
  "env": { "KEY": "value" },
  "packages": ["sentry@8.0.0", "stripe"]
}
```

### Schema Discovery
```
GET /api/discover?packages=sentry,stripe,prisma
```

### Catalog
```
GET /api/catalog.json
```

## License

MIT