# Varlock PHP SDK - Proof of Concept

> **TL;DR:** This PoC proves that `varlock compile` can produce a JSON manifest
> that PHP frameworks consume at boot time - no Node.js runtime, no `exec()`,
> no sidecar. Secrets are resolved from external APIs (1Password, Vault, etc.)
> and never stored in `.env` files. This makes codebases safe for AI agents
> that can read the filesystem but cannot reach a secrets API.

---

## Table of contents

1. [Why PHP needs a different approach](#why-php-needs-a-different-approach)
2. [How .env works in PHP (background for JS folks)](#how-env-works-in-php)
3. [The compiled manifest approach](#the-compiled-manifest-approach)
4. [Package structure](#package-structure)
5. [How the bootstrap works](#how-the-bootstrap-works)
6. [Secret resolution](#secret-resolution)
7. [The AI agent safety argument](#the-ai-agent-safety-argument)
8. [Running the demo](#running-the-demo)
9. [What `varlock compile` would need to generate](#what-varlock-compile-would-need-to-generate)
10. [Design decisions and trade-offs](#design-decisions-and-trade-offs)
11. [Extending to other languages](#extending-to-other-languages)

---

## Why PHP needs a different approach

In the JS ecosystem, varlock hooks into the module loader - it intercepts
`process.env` access at the language level. PHP has no equivalent. There is no
module loader to hook into, no way to intercept `$_ENV` reads, and shelling out
to a Node.js binary on every request is a non-starter for performance.

But PHP applications **do** have a well-defined boot sequence with a clear
moment where env vars are loaded. If we can inject values into `$_ENV` at the
right point in that sequence, every call to `env('DB_PASSWORD')` downstream
sees our values - no framework patches, no monkey-patching.

That is what this PoC does. The JS side (`varlock compile`) produces a static
JSON manifest. The PHP side reads it once at boot and injects values into the
environment. The two halves never run simultaneously.

---

## How .env works in PHP

This section exists because `.env` handling is fundamentally different between
Node.js and PHP, and these differences shape every design decision in this PoC.

### The three places env vars live

PHP has three independent places where environment variables can be read:

```php
$_ENV['DB_PASSWORD']        // superglobal array (populated at PHP startup)
$_SERVER['DB_PASSWORD']     // superglobal array (populated by web server / CLI)
getenv('DB_PASSWORD')       // reads from the C-level environ (libc)
```

To reliably set an env var that every library will see, you must write to all
three:

```php
$_ENV[$key]    = $value;
$_SERVER[$key] = $value;
putenv("$key=$value");
```

This is exactly what our `VarlockBootstrap::setEnv()` does.

### Laravel's boot sequence

Laravel boots in a strict order. Understanding this order is critical because
**varlock must inject values after step 1 but before step 2**:

```
1. LoadEnvironmentVariables  - reads .env via vlucas/phpdotenv, populates $_ENV
2. LoadConfiguration         - requires config/*.php files, each calls env('APP_KEY')
3. RegisterProviders         - runs service providers (too late for env injection)
4. BootProviders             - calls boot() on each provider
```

The `env()` helper in step 2 reads from `$_ENV`. If `APP_KEY` is empty in
`$_ENV` at that point, `config('app.key')` will be empty for the entire
request - even if a service provider later sets it.

**Our hook point:**

```php
// bootstrap/app.php
$app->afterBootstrapping(LoadEnvironmentVariables::class, function () use ($app) {
    \Varlock\Laravel\VarlockBootstrap::load($app->basePath());
});
```

This callback fires after Dotenv has parsed `.env` (step 1) but before config
files are loaded (step 2). At this point `.env` values are in `$_ENV`, and
our bootstrap can see them, decide which ones are empty, resolve the missing
secrets from an external API, and write them back into `$_ENV` before
`config/app.php` ever calls `env('APP_KEY')`.

**Key detail - immutable Dotenv:** Laravel uses `Dotenv::createImmutable()`,
which means Dotenv will **not** overwrite values that already exist in `$_ENV`.
This is a feature for us: if we wrote values into `$_ENV` before Dotenv ran,
Dotenv would skip them. But since we run *after* Dotenv, we're the ones
overwriting Dotenv's empty values with resolved secrets. Both directions work.

**Config caching:** In production, Laravel can cache all config into a single
PHP file (`php artisan config:cache`). When this cache exists, `.env` is never
read and `env()` calls return `null`. Our bootstrap detects this
(`bootstrap/cache/config.php` exists) and skips resolution entirely - the
cached config already has the baked-in values from when the cache was generated.

### Symfony's boot sequence

Symfony is simpler but has its own quirk:

```
1. public/index.php          - requires autoload_runtime.php
2. autoload_runtime.php       - loads .env via Symfony\Dotenv, boots the runtime
3. Runtime calls the closure  - receives $context with APP_ENV, APP_DEBUG
4. Kernel boots               - compiles the container, loads bundles
```

The `.env` is loaded inside `autoload_runtime.php` (step 2), and the closure
in `index.php` receives the loaded context (step 3). Our hook:

```php
// public/index.php
return function (array $context) {
    \Varlock\Symfony\VarlockBootstrap::load(dirname(__DIR__));
    return new Kernel($context['APP_ENV'], (bool) $context['APP_DEBUG']);
};
```

By the time our bootstrap runs, Dotenv has already populated `$_ENV`. We
resolve missing secrets and write them back. The kernel then boots with
all values available.

**Key difference from Laravel:** Symfony does not coerce types at the env
level. Instead, it uses "env processors" in config files:
`%env(bool:APP_DEBUG)%`, `%env(int:DB_PORT)%`. So our Symfony bootstrap
stores all values as strings and skips the type coercion step.

### Comparison table

| Aspect | Laravel | Symfony | Node.js (for reference) |
|---|---|---|---|
| .env library | vlucas/phpdotenv | symfony/dotenv | dotenv (or built-in) |
| Where env lives | `$_ENV`, `$_SERVER`, `getenv()` | `$_ENV`, `$_SERVER`, `getenv()` | `process.env` |
| Config reads env at | Boot time (config files loaded once) | Compile time (container compiled once) | Runtime (every access) |
| Type coercion | Manual (`(bool) env('DEBUG')`) | Env processors (`%env(bool:DEBUG)%`) | Manual |
| Config caching | `php artisan config:cache` | `bin/console cache:warmup` | N/A |
| Our hook point | `afterBootstrapping(LoadEnv)` | Inside runtime closure | Module loader |

---

## The compiled manifest approach

The manifest is the contract between the JS tooling and the PHP runtime:

```
  varlock compile (JS/Node)          manifest.json            PHP bootstrap
 ┌──────────────────────┐       ┌──────────────────┐      ┌─────────────────┐
 │ Reads .env.spec      │──────>│ Schema rules     │─────>│ Validates env   │
 │ Reads plugin configs │       │ Default values   │      │ Resolves secrets│
 │ Zero secrets in file │       │ Resolve configs  │      │ Coerces types   │
 └──────────────────────┘       │ Sensitive flags   │      │ Redacts logs    │
                                └──────────────────┘      └─────────────────┘
                                     Safe to commit
                                     Safe for AI to read
```

Example manifest (committed to repo, contains zero secrets):

```json
{
  "items": {
    "APP_KEY": {
      "type": "string",
      "required": true,
      "sensitive": true,
      "resolve": {
        "plugin": "1password",
        "endpoint": "http://localhost:9777/secrets",
        "field": "APP_KEY"
      }
    },
    "DB_HOST": {
      "type": "string",
      "required": true,
      "sensitive": false,
      "default": "127.0.0.1"
    }
  }
}
```

The `resolve` block tells the PHP SDK *how* to get the secret, not *what* the
secret is. The `endpoint` could be 1Password Connect, HashiCorp Vault, AWS
Secrets Manager, or any HTTP API.

---

## Package structure

```
packages/sdks/
├── php-core/                          # varlock/php-core - framework-agnostic
│   ├── composer.json
│   └── src/
│       ├── ManifestLoader.php         # Reads .varlock/manifest.json
│       ├── Validator.php              # Checks required fields, validates types
│       ├── TypeCoercer.php            # "3306" → 3306, "true" → true
│       ├── VarlockState.php           # Static singleton: holds values + sensitive map
│       ├── RedactionHelper.php        # Replaces secret values with [REDACTED]
│       ├── SecretResolverFactory.php  # Registry that dispatches to plugin resolvers
│       ├── Contracts/
│       │   └── SecretResolverInterface.php
│       ├── Resolvers/
│       │   ├── HttpSecretResolver.php      # Calls any HTTP secrets API
│       │   ├── EnvSecretResolver.php       # Reads from process env (Docker/K8s)
│       │   ├── CallbackSecretResolver.php  # Wraps a user-provided closure
│       │   └── ChainSecretResolver.php     # Tries resolvers in order (fallback)
│       └── Exceptions/
│           ├── VarlockValidationException.php
│           └── ManifestNotFoundException.php
│
├── php-laravel/                       # varlock/laravel - Laravel integration
│   ├── composer.json
│   └── src/
│       ├── VarlockBootstrap.php       # The main entry point, called from bootstrap/app.php
│       ├── VarlockServiceProvider.php # Registers artisan command + Monolog processor
│       ├── Console/
│       │   └── StatusCommand.php      # `php artisan varlock:status`
│       └── Logging/
│           └── RedactSensitiveProcessor.php  # Monolog processor
│
└── php-symfony/                       # varlock/symfony-bundle - Symfony integration
    ├── composer.json
    └── src/
        ├── VarlockBootstrap.php       # Called from public/index.php
        ├── VarlockBundle.php          # Registers Monolog processor via DI
        └── Logging/
            └── RedactSensitiveProcessor.php  # Monolog processor
```

**Why three packages?**

- `php-core` has zero framework dependencies - just PHP 8.2. Could be used
  with Slim, Laminas, WordPress, or any custom app.
- `php-laravel` and `php-symfony` are thin wrappers that know where to hook
  into each framework's boot sequence.

This mirrors varlock's JS architecture: core logic in one place, integrations
for Next.js / Vite / Astro as separate packages.

---

## How the bootstrap works

Every request (HTTP or CLI) goes through this flow once:

```
1. Framework loads .env file into $_ENV
   └─ At this point: DB_PASSWORD="" (empty - no secret in .env)

2. VarlockBootstrap::load() runs
   ├─ Reads .varlock/manifest.json
   ├─ For each item in manifest:
   │   ├─ Check $_ENV - is there already a value?     → use it
   │   ├─ Is there a "resolve" block?                  → call secret API
   │   └─ Is there a "default"?                        → use it
   ├─ Validate all values (required? correct type?)
   ├─ Coerce types (Laravel only - Symfony skips this)
   ├─ Write resolved values into $_ENV / $_SERVER / putenv()
   └─ Store sensitive value map in VarlockState singleton

3. Framework loads config files (config/app.php etc.)
   └─ env('DB_PASSWORD') now returns the resolved secret

4. Application runs normally
   └─ Any log message containing a secret value → [REDACTED] by Monolog processor
```

The key insight: step 2 happens in a ~5ms window between "dotenv loaded" and
"config parsed". The secret never exists on the filesystem. It lives in
process memory for the duration of the request.

---

## Secret resolution

### Resolution priority

For each item in the manifest, the bootstrap tries three sources in order:

```
1. Existing env var  -  from .env, process env, or Docker/K8s injection
2. Resolve block     -  calls external API (1Password, Vault, HTTP, etc.)
3. Default value     -  from the manifest itself
```

If all three fail for a `required: true` item, the app crashes at boot with a
clear error message listing all missing vars. This is intentional - fail fast,
fail loud.

### Built-in resolvers

**HttpSecretResolver** - The workhorse. Calls any HTTP endpoint, parses JSON,
extracts a field by dot-notation path. Caches responses per endpoint so
multiple secrets from the same API (e.g. batch endpoint) make only one HTTP
request.

```json
{
  "resolve": {
    "plugin": "1password",
    "endpoint": "http://op-connect:8080/v1/vaults/abc/items/def",
    "field": "fields.password.value",
    "headers": { "Authorization": "Bearer {{OP_CONNECT_TOKEN}}" }
  }
}
```

Note the `{{OP_CONNECT_TOKEN}}` - header values can reference process
env vars (injected by the orchestrator, not from `.env`). This way the
*token to authenticate with the secret manager* also never touches the
filesystem.

**EnvSecretResolver** - For Docker/Kubernetes environments where the
orchestrator injects secrets as process env vars. Reads from
`VARLOCK_SECRET_DB_PASSWORD` (prefixed to avoid collision with the actual
`DB_PASSWORD` key).

**CallbackSecretResolver** - Escape hatch. Wrap any PHP closure:

```php
SecretResolverFactory::register('custom', new CallbackSecretResolver(
    fn(array $config) => MyVault::getSecret($config['key'])
));
```

**ChainSecretResolver** - Try multiple resolvers in order:

```php
SecretResolverFactory::register('1password', new ChainSecretResolver([
    new HttpSecretResolver(),    // try Connect API first
    new EnvSecretResolver(),     // fall back to orchestrator env
]));
```

### Auto-registration

The bootstrap scans the manifest for `resolve` blocks. If a plugin has an
`endpoint` field and no resolver is manually registered, the
`HttpSecretResolver` is automatically registered for that plugin. This means
**zero configuration** for HTTP-based secret managers - just put the endpoint
in the manifest.

---

## The AI agent safety argument

This is the motivating use case for the whole approach.

### The problem

AI coding agents (Claude, Copilot, Cursor, etc.) operate by reading files in
the project directory. A `.env` file containing `DB_PASSWORD=hunter2` is
trivially readable by any agent with file system access. The secret is now in
the agent's context window and potentially in API logs, training data, or
error reports.

### The current state

```
# .env (today - secrets on filesystem)
APP_KEY=base64:9McFRwiu6WCB21XjXdjz2b3njJCsnsVS6Qmz9FbdDGk=
DB_PASSWORD=prod-db-P@ssw0rd!-2026-rotated
STRIPE_SECRET=sk_live_abc123...
```

Every file-reading tool call can leak these.

### With varlock

```
# .env (with varlock - no secrets on filesystem)
APP_KEY=
DB_PASSWORD=
STRIPE_SECRET=
```

```json
// .varlock/manifest.json (safe to read - zero secrets)
{
  "items": {
    "DB_PASSWORD": {
      "required": true,
      "sensitive": true,
      "resolve": {
        "plugin": "1password",
        "endpoint": "http://op-connect:8080/v1/vaults/abc/items/def",
        "field": "DB_PASSWORD"
      }
    }
  }
}
```

The AI agent can read both files. It learns that `DB_PASSWORD` is required,
that it's a string, that it's sensitive, and that it comes from 1Password.
It learns *everything it needs to work with the codebase* except the actual
secret value. The secret only exists in process memory at runtime, resolved
via an HTTP call the agent cannot make.

### Defense in depth with log redaction

Even if application code accidentally logs a secret:

```php
Log::info("Connecting with password: {$dbPassword}");
```

The Monolog processor intercepts this and writes:

```
[2026-03-14] local.INFO: Connecting with password: [REDACTED]
```

The `VarlockState` singleton knows which values are sensitive (from the
manifest's `sensitive: true` flag) and the `RedactSensitiveProcessor`
replaces any occurrence of those values in log messages. This means even log
files are safe for AI agents to read.

---

## Running the demo

Prerequisites: PHP 8.2+, Composer.

### 1. Start the mock secret server

```bash
php examples/mock-secret-server.php &
# Serves secrets on http://localhost:9777
# In production, this would be 1Password Connect, Vault, etc.
```

### 2. Laravel

```bash
cd examples/laravel-app

# See that .env has NO secrets:
grep -E "^(APP_KEY|DB_PASSWORD)" .env
# APP_KEY=
# DB_PASSWORD=

# Yet the app boots and resolves them from the mock API:
php artisan varlock:status
# +-------------+---------+----------+-----------+--------------+
# | Key         | Type    | Required | Sensitive | Value        |
# | APP_KEY     | string  | Yes      | Yes       | [REDACTED]   |
# | DB_PASSWORD | string  | Yes      | Yes       | [REDACTED]   |
# | DB_HOST     | string  | Yes      | No        | 127.0.0.1    |
# +-------------+---------+----------+-----------+--------------+

# Web server works too:
php artisan serve --port=8077 &
curl localhost:8077/varlock/status    # JSON with redacted secrets
curl localhost:8077/varlock/log-test  # check storage/logs/laravel.log - password is [REDACTED]
```

### 3. Symfony

```bash
cd examples/symfony-app
php -S localhost:8078 -t public &
curl localhost:8078/varlock/status    # JSON with redacted secrets
```

### 4. Kill the mock server when done

```bash
kill %1  # or: lsof -ti:9777 | xargs kill
```

---

## What `varlock compile` would need to generate

For PHP support, the `compile` command would write `.varlock/manifest.json`
with this schema:

```typescript
interface Manifest {
  version: string;
  generatedAt: string;     // ISO timestamp
  items: Record<string, ManifestItem>;
}

interface ManifestItem {
  type: 'string' | 'boolean' | 'number' | 'integer' | 'email' | 'url';
  required: boolean;
  sensitive: boolean;
  default?: string;        // always a string - PHP SDK handles coercion
  resolve?: ResolveConfig; // only for items backed by a secret manager
}

interface ResolveConfig {
  plugin: string;          // matches a varlock plugin name (e.g. "1password")
  endpoint: string;        // HTTP URL for the secrets API
  field?: string;          // dot-notation path into the JSON response
  headers?: Record<string, string>; // {{ENV_VAR}} placeholders expanded at runtime
}
```

This is the *only* artifact the JS side needs to produce. The PHP SDK does
everything else.

### Mapping from existing varlock concepts

| Varlock JS concept | Manifest field | Notes |
|---|---|---|
| Item type (`VarlockDataType`) | `type` | Simplified to primitive types |
| `@required` decorator | `required` | |
| `@sensitive` decorator | `sensitive` | Drives redaction |
| Default value | `default` | Serialized as string |
| `op()` / `awsSecret()` resolver | `resolve.plugin` + `resolve.endpoint` | The PHP SDK doesn't import the JS plugin - it just calls the HTTP endpoint |
| `@initOp()` config | `resolve.headers` | Auth tokens etc. |

---

## Design decisions and trade-offs

### Why a static manifest instead of running the JS engine?

- **Performance:** PHP-FPM processes are short-lived. Spawning Node on every
  request adds 50-200ms. The manifest is read in <1ms.
- **No runtime dependency:** Production PHP servers don't need Node.js
  installed.
- **Simplicity:** JSON is the universal data format. Any language can read it.

Trade-off: the manifest must be regenerated when the schema changes
(`varlock compile` in CI or as a git hook).

### Why HTTP-based secret resolution instead of CLI tools?

1Password's `op` CLI, AWS CLI, etc. require shelling out (`exec()`), which is
slow, blocked on many hosting platforms, and a security red flag. HTTP calls
via `file_get_contents()` work everywhere and complete in milliseconds on a
local network.

In production, you'd run 1Password Connect as a sidecar or use the managed
service endpoint. The PHP SDK just makes a GET request.

### Why three env writes (`$_ENV`, `$_SERVER`, `putenv`)?

Different PHP libraries read env from different sources. Laravel's `env()`
checks all three. Symfony's `Dotenv` writes to all three. Some legacy code
uses `getenv()` directly. Writing to all three ensures compatibility.

### Why does VarlockState use a static singleton?

PHP has no application-level dependency injection that survives across the
boot sequence (before the framework container exists). A static singleton
ensures the Monolog processor (registered later via the service provider)
can access the sensitive values map without constructor injection.

### Why skip resolution when Laravel config is cached?

When `php artisan config:cache` runs, it evaluates all `env()` calls once and
dumps the results to `bootstrap/cache/config.php`. After that, `env()` returns
`null` - the cached values are used directly. Calling the secret API would
be wasteful and would fail if the API isn't reachable during deployment.

---

## Extending to other languages

The manifest approach is designed to be language-agnostic. Here's what each
new language SDK needs:

1. **Manifest reader** - Parse JSON. Every language has this.
2. **Env injector** - Write values into the language's env mechanism
   (`process.env`, `os.environ`, `$_ENV`, `System.getenv()`).
3. **Boot hook** - Find the right moment in the framework's lifecycle.
4. **Secret resolver** - HTTP client to call the secrets API.
5. **Log redactor** - Hook into the logging framework.

| Language | Framework | Boot hook | Env mechanism | Logging |
|---|---|---|---|---|
| PHP | Laravel | `afterBootstrapping()` | `$_ENV`/`putenv()` | Monolog processor |
| PHP | Symfony | Runtime closure | `$_ENV`/`putenv()` | Monolog processor |
| Python | Django | `settings.py` or `AppConfig.ready()` | `os.environ` | `logging.Filter` |
| Python | FastAPI | `lifespan` event | `os.environ` | `logging.Filter` |
| Ruby | Rails | `config/initializers/` | `ENV` | `ActiveSupport::Logger` |
| Go | Any | `init()` or `main()` | `os.Setenv()` | `slog.Handler` |
| Rust | Any | `main()` before framework | `std::env::set_var()` | `tracing` layer |

The hard part is always finding the right boot hook. The manifest format and
resolution logic are identical across languages.

---

## File inventory

New files added by this PoC (relative to repo root):

```
packages/sdks/php-core/           14 files   Core library, no framework deps
packages/sdks/php-laravel/         5 files   Laravel service provider + bootstrap
packages/sdks/php-symfony/         4 files   Symfony bundle + bootstrap
examples/.varlock/manifest.json    1 file    Shared example manifest
examples/mock-secret-server.php    1 file    Demo HTTP secrets API
examples/laravel-app/              ~60 files Laravel 11 skeleton + varlock integration
examples/symfony-app/              ~30 files Symfony 8 skeleton + varlock integration
```

No existing files were modified except `.gitignore` (added PHP entries).
