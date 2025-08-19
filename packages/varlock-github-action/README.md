# Varlock GitHub Action

A GitHub Action that loads and validates environment variables using [varlock](https://github.com/dmno-dev/varlock). This action automatically detects varlock installations or .env.schema/.env.* files and loads validated environment variables into the GitHub Actions environment.

## Features

- 🔍 **Automatic detection**: Checks for varlock installation or compatible env files
- 📦 **Auto-installation**: Installs varlock if not found
- 🔒 **Schema validation**: Validates environment variables against your schema
- 📋 **Summary output**: Provides detailed summaries of loaded variables
- ⚙️ **Flexible configuration**: Supports different output formats and environments
- ✅ **All .env.* files are supported**: You can use any .env.* file to load environment variables (not just .env.schema)

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
      
      - name: Set environment flag
        run: echo "APP_ENV=production" >> $GITHUB_ENV
      
      - name: Load environment variables
        uses: dmno-dev/varlock-github-action@v1
        with:
          working-directory: './config'
          show-summary: 'true'
          fail-on-error: 'true'
      
      - name: Use loaded variables
        run: |
          echo "Environment loaded successfully"
```

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `working-directory` | Directory containing @env-spec files | No | `.` |
| `show-summary` | Show a summary of loaded environment variables | No | `true` |
| `fail-on-error` | Fail the action if validation errors are found | No | `true` |
| `output-format` | Format for environment variable output (env, json) | No | `env` |

## Outputs

| Output | Description |
|--------|-------------|
| `summary` | Summary of loaded environment variables |
| `error-count` | Number of validation errors found |
| `json-env` | JSON blob containing all environment variables (only available when output-format is "json") |

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
      
      - name: Set environment flag
        run: |
          if [ "${{ github.ref }}" = "refs/heads/main" ]; then
            echo "APP_ENV=production" >> $GITHUB_ENV
          else
            echo "APP_ENV=staging" >> $GITHUB_ENV
          fi
      
      - name: Load environment variables
        uses: dmno-dev/varlock-github-action@v1
        with:
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
      
      - name: Set environment flag
        run: echo "APP_ENV=production" >> $GITHUB_ENV
      
      - name: Load environment variables
        uses: dmno-dev/varlock-github-action@v1
        with:
          working-directory: './config/environments'
      
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
- **File Not Found**: Warns if no .env.* files are detected

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

- **Sensitive Data Protection**: Variables marked with `@sensitive` are automatically exported as GitHub secrets, preventing them from appearing in logs
- **Schema Validation**: Ensures all required variables are present and valid
- **Type Safety**: Validates variable types (string, number, boolean, enum)
- **Environment Isolation**: Supports different environments with different schemas
- **Third Party Secrets Support**: Loads secrets from third party secrets providers like 1Password, LastPass, etc.
  - Note: any CLIs you need to retrieve third party secrets will also need to be installed
- **Automatic Secret Masking**: Sensitive values are automatically masked in GitHub Actions logs using `core.setSecret()`

## Output Formats

The action always uses varlock's `json-full` format internally to get complete information including sensitive flags. The `output-format` parameter determines how the final output is presented:

- **`env`** (default): Exports variables as environment variables and secrets
  - Non-sensitive values are exported as regular environment variables
  - Sensitive values are exported as both secrets (for masking) and environment variables (for use)
- **`json`**: Outputs a single JSON blob with all environment variables
  - Available as the `json-env` action output
  - Useful for passing to other tools or storing as artifacts

## Sensitive Data Handling

The action automatically detects and handles sensitive environment variables based on your `.env.schema` configuration:

### How it works:

1. **Detection**: Variables marked with `@sensitive` decorator in your schema are identified
2. **Secret Export**: Sensitive values are exported using `core.setSecret()` to mask them in logs
3. **Environment Variables**: Both sensitive and non-sensitive values are available as environment variables in subsequent steps

### Example Schema:

```env-spec
# @defaultSensitive=false
# ---
# Public configuration
NODE_ENV=development
API_URL=https://api.example.com

# Sensitive configuration
# @sensitive
DATABASE_PASSWORD=your-secure-password
# @sensitive
API_KEY=sk-1234567890abcdef
```

### In GitHub Actions:

```yaml
- name: Load environment variables
  uses: dmno-dev/varlock-github-action@v1

- name: Use variables
  run: |
    echo "Environment: $NODE_ENV"           # Visible in logs
    echo "API URL: $API_URL"               # Visible in logs
    echo "Database: $DATABASE_PASSWORD"    # Masked in logs
    echo "API Key: $API_KEY"               # Masked in logs
```

The sensitive values (`DATABASE_PASSWORD` and `API_KEY`) will be automatically masked in the GitHub Actions logs, while non-sensitive values remain visible for debugging purposes.

### JSON Output Format

```yaml
- name: Load environment variables as JSON
  uses: dmno-dev/varlock-github-action@v1
  with:
    output-format: 'json'
  id: varlock

- name: Use JSON output
  run: |
    echo "JSON output: ${{ steps.varlock.outputs.json-env }}"
    
    # Parse and use specific values
    echo "Database URL: $(echo '${{ steps.varlock.outputs.json-env }}' | jq -r '.DATABASE_URL')"
```

## Contributing

This action is part of the varlock ecosystem. For issues and contributions, please visit the [varlock repository](https://github.com/dmno-dev/varlock).

## License

MIT License - see the [varlock repository](https://github.com/dmno-dev/varlock) for details. 