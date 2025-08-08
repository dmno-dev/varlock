# Varlock GitHub Action

A GitHub Action that loads and validates environment variables using [varlock](https://github.com/dmno-dev/varlock). This action automatically detects varlock installations or .env.schema/.env.* files and loads validated environment variables into the GitHub Actions environment.

## Features

- 🔍 **Automatic Detection**: Checks for varlock installation or compatible env files
- 📦 **Auto-Installation**: Installs varlock if not found
- 🔒 **Schema Validation**: Validates environment variables against your schema
- 📋 **Summary Output**: Provides detailed summaries of loaded variables
- ⚙️ **Flexible Configuration**: Supports different output formats and environments

## Usage

### Basic Usage

```yaml
name: Load Environment Variables
on: [push, pull_request]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Load environment variables
        uses: dmno-dev/varlock-github-action@v1
      
      - name: Use loaded variables
        run: |
          echo "Database URL: $DATABASE_URL"
          echo "API Key: $API_KEY"
```

### With Custom Configuration

```yaml
name: Load Environment Variables
on: [push, pull_request]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Load environment variables
        uses: dmno-dev/varlock-github-action@v1
        with:
          working-directory: './config'
          environment: 'production'
          show-summary: 'true'
          fail-on-error: 'true'
          output-format: 'env'
      
      - name: Use loaded variables
        run: |
          echo "Environment loaded successfully"
```

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `working-directory` | Directory containing @env-spec files | No | `.` |
| `environment` | Environment to load (e.g., production, development) | No | - |
| `show-summary` | Show a summary of loaded environment variables | No | `true` |
| `fail-on-error` | Fail the action if validation errors are found | No | `true` |
| `output-format` | Format for environment variable output (env, json) | No | `env` |

## Outputs

| Output | Description |
|--------|-------------|
| `summary` | Summary of loaded environment variables |
| `error-count` | Number of validation errors found |
| `warning-count` | Number of validation warnings found |

## @env-spec Environment File Detection

The action automatically detects @env-spec environment files in the following order:

1. **`.env.schema`** - Primary schema file with @env-spec decorators
2. **`.env` with @env-spec decorators** - .env file containing @env-spec decorators

### Example .env.schema file

```env
# @generateTypes(lang='ts', path='env.d.ts')
# @defaultSensitive=false
# @envFlag=APP_ENV
# ---

# --- Database configuration ---
# Database connection URL
# @required @sensitive @type=string(startsWith="postgresql://")
# @docsUrl=https://docs.varlock.dev/guides/environments
DATABASE_URL=encrypted("postgresql://user:pass@localhost:5432/db")

# Redis connection URL
# @required @sensitive @type=string(startsWith="redis://")
REDIS_URL=encrypted("redis://localhost:6379")

# --- API configuration ---
# API secret key for authentication
# @required @sensitive @type=string(startsWith="sk_")
API_KEY=encrypted("sk-1234567890abcdef")

# --- Application settings ---
# Enable debug mode
# @example=false
DEBUG=false

# Server port number
# @example=3000
PORT=3000

# Application environment
# @example=development
NODE_ENV=development
```

## Examples

### Basic CI/CD Pipeline

```yaml
name: CI/CD Pipeline
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Load environment variables
        uses: dmno-dev/varlock-github-action@v1
      
      - name: Run tests
        run: npm test
        env:
          NODE_ENV: test
      
      - name: Build application
        run: npm run build
```

### Multi-Environment Deployment

```yaml
name: Deploy
on:
  push:
    branches: [main, staging]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Load environment variables
        uses: dmno-dev/varlock-github-action@v1
        with:
          environment: ${{ github.ref == 'refs/heads/main' && 'production' || 'staging' }}
          show-summary: 'true'
      
      - name: Deploy to environment
        run: |
          echo "Deploying to $NODE_ENV"
          # Your deployment script here
```

### With Custom Working Directory

```yaml
name: Load Environment Variables
on: [push, pull_request]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Load environment variables
        uses: dmno-dev/varlock-github-action@v1
        with:
          working-directory: './config/environments'
          environment: 'production'
      
      - name: Use loaded variables
        run: |
          echo "Database: $DATABASE_URL"
          echo "Redis: $REDIS_URL"
```

## Error Handling

The action provides comprehensive error handling:

- **Validation Errors**: Fails if required variables are missing or invalid (configurable)
- **Schema Errors**: Fails if schema file has syntax errors
- **Installation Errors**: Fails if varlock cannot be installed
- **File Not Found**: Warns if no .env.schema or .env.* (with @env-spec decorators) files are detected

### Error Output Example

```yaml
- name: Load environment variables
  uses: dmno-dev/varlock-github-action@v1
  with:
    fail-on-error: 'false'  # Continue on validation errors
    show-summary: 'true'
```

## Security Features

This action leverages varlock's security features:

- **Sensitive Data Protection**: Variables marked with `@sensitive` are protected from leaks
- **Schema Validation**: Ensures all required variables are present and valid
- **Type Safety**: Validates variable types (string, number, boolean, enum)
- **Environment Isolation**: Supports different environments with different schemas
- **Third Party Secrets Support**: Loads secrets from third party secrets providers like 1Password, LastPass, etc.
  - Note: any CLIs you need to retrieve third party secrets will also need to be installed

## Contributing

This action is part of the varlock ecosystem. For issues and contributions, please visit the [varlock repository](https://github.com/dmno-dev/varlock).

## License

MIT License - see the [varlock repository](https://github.com/dmno-dev/varlock) for details. 