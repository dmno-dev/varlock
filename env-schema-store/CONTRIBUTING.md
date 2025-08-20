# Contributing to the Environment Schema Store

Thank you for your interest in contributing to the Environment Schema Store! This guide will help you add new schemas, improve existing ones, and contribute to the project.

## Table of Contents

- [Getting Started](#getting-started)
- [Adding a New Schema](#adding-a-new-schema)
- [Improving Existing Schemas](#improving-existing-schemas)
- [Schema Guidelines](#schema-guidelines)
- [Testing Your Schema](#testing-your-schema)
- [Submitting a Pull Request](#submitting-a-pull-request)

## Getting Started

1. Fork the repository
2. Clone your fork locally
3. Create a new branch for your contribution
4. Make your changes
5. Test your changes
6. Submit a pull request

## Adding a New Schema

### 1. Research the Package

Before creating a schema, research the package thoroughly:
- Read the official documentation
- Check environment variable examples
- Look for configuration guides
- Review GitHub issues for common problems

### 2. Choose the Right Category

Place your schema in the appropriate category folder:
- `ai/` - AI and machine learning services
- `auth/` - Authentication and authorization
- `database/` - Databases and ORMs
- `email/` - Email services
- `monitoring/` - Monitoring and analytics
- `payments/` - Payment processing
- `storage/` - File storage services
- `messaging/` - Messaging and communication
- `deployment/` - Deployment and hosting
- `testing/` - Testing and CI/CD

### 3. Create the Schema File

Create a new file: `schemas/[category]/[package-name].env.schema`

```env
# Package Name Environment Variables
# @package npm-package-name another-package-name
# @version ^1.0.0
# @url https://docs.example.com

# === Required Configuration ===

# @required @secret
# @desc API key for authentication
# @pattern ^[a-zA-Z0-9]{32}$
# @example abc123def456ghi789jkl012mno345pq
API_KEY=

# @required @public
# @desc API endpoint URL
# @pattern ^https?:\/\/.+$
# @default https://api.example.com
API_URL=

# === Optional Configuration ===

# @optional @public @number
# @desc Request timeout in milliseconds
# @default 30000
# @min 1000
# @max 300000
TIMEOUT=

# @optional @public @boolean
# @desc Enable debug logging
# @default false
DEBUG=
```

### 4. Add to Catalog

Add an entry to `catalog.json`:

```json
{
  "name": "your-package",
  "displayName": "Your Package",
  "description": "Brief description of the package",
  "category": "appropriate-category",
  "url": "https://package-website.com",
  "packageNames": ["npm-package-name", "alternative-name"],
  "schemaFile": "schemas/category/your-package.env.schema",
  "versions": {
    "2.0.0": "schemas/category/your-package-v2.env.schema",
    "1.0.0": "schemas/category/your-package.env.schema"
  },
  "frameworks": {
    "nextjs": {
      "envPrefix": ["NEXT_PUBLIC_", ""],
      "schemaFile": "schemas/category/your-package-nextjs.env.schema"
    }
  }
}
```

## Improving Existing Schemas

### Adding Missing Variables

If you discover missing environment variables:
1. Research the variable thoroughly
2. Add it with appropriate decorators
3. Include clear descriptions and examples
4. Test with a real application

### Updating for New Versions

When a package releases a new version with changes:
1. Create a new version-specific schema file
2. Update the `versions` section in `catalog.json`
3. Maintain backward compatibility

### Adding Framework Support

If a package uses different variables for different frameworks:
1. Create framework-specific schema files
2. Update the `frameworks` section in `catalog.json`
3. Document the differences clearly

## Schema Guidelines

### Variable Naming

- Use the exact variable names from the official documentation
- Follow the package's naming conventions
- Be consistent with prefixes and suffixes

### Priority Levels

Choose the appropriate priority:
- `@required` - Application won't function without it
- `@optional` - Has a sensible default or isn't always needed
- `@suggested` - Enhances functionality but not critical

### Security Classification

Always classify security:
- `@secret` - API keys, tokens, passwords, credentials
- `@public` - URLs, feature flags, non-sensitive configuration

### Type Annotations

Use type decorators when appropriate:
- `@number` - Numeric values (ports, timeouts, limits)
- `@boolean` - True/false flags
- `@array` - Comma-separated lists
- `@json` - JSON objects

### Validation Patterns

Include regex patterns for validation:
```env
# @pattern ^sk_(test|live)_[a-zA-Z0-9]{24,}$
STRIPE_SECRET_KEY=

# @pattern ^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$
EMAIL_ADDRESS=
```

### Documentation

Every variable should have:
- `@desc` - Clear, concise description
- `@example` - Real-world example (sanitized)
- `@default` - Default value if applicable

### Enumerations

For variables with fixed options:
```env
# @enum development staging production
ENVIRONMENT=

# @enum debug info warn error
LOG_LEVEL=
```

## Testing Your Schema

### 1. Manual Testing

Create a test `.env` file and validate:
```bash
# Install varlock
npm install -g varlock

# Create test .env
echo "# @load your-package" > .env
echo "API_KEY=test123" >> .env

# Validate
varlock doctor
```

### 2. Automated Testing

Run the schema validator:
```bash
npm run validate-schema schemas/category/your-package.env.schema
```

### 3. Integration Testing

Test with a real application:
1. Create a sample project
2. Install the target package
3. Configure with your schema
4. Verify all variables work correctly

## Submitting a Pull Request

### PR Title

Use a clear, descriptive title:
- `Add schema for [package-name]`
- `Update [package-name] schema for v2.0`
- `Add Next.js support to [package-name] schema`

### PR Description

Include in your description:
- Package name and version
- Link to official documentation
- List of environment variables added
- Testing performed
- Any special considerations

### PR Template

```markdown
## Schema Addition/Update

**Package:** [package-name]
**Version:** [version]
**Documentation:** [link]

### Changes
- [ ] Added new schema for [package]
- [ ] Updated existing schema
- [ ] Added framework support
- [ ] Added version support

### Variables Added
- `VAR_NAME` - Description

### Testing
- [ ] Validated schema syntax
- [ ] Tested with real application
- [ ] Verified all decorators
- [ ] Checked security classifications

### Notes
Any additional context or considerations
```

## Code of Conduct

- Be respectful and constructive
- Focus on accuracy and completeness
- Test thoroughly before submitting
- Respond to feedback promptly
- Help review other contributions

## Questions?

If you have questions:
1. Check existing schemas for examples
2. Open a discussion issue
3. Ask in the pull request
4. Contact maintainers

Thank you for contributing to making environment configuration safer and easier for everyone!