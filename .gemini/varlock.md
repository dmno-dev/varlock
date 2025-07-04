---
description: Varlock Environment Specification Rules
globs: [".env.schema"]
---
# Varlock Environment Specification Rules

Rules for working with varlock env-spec files, providing syntax highlighting, autocompletion, and validation for environment variable specifications.

## Rule: env_spec_rules

**Description:** Standards for working with env-spec files in varlock projects.

**Filters:**

*   **File Extension:** Matches `.env.schema` or `.env.*` files.
*   **Content:** Matches files that look like env-spec files.
*   **Event:** Matches file creation and modification events.

**Actions:**

*   **Suggest:**
    *   **Message:**
        > When working with env-spec files:
        >
        > 1.  File Structure:
        >     ```
        >     .env.schema          # Schema definition with decorators
        >     .env                 # Local development values
        >     .env.production      # Production values
        >     .env.staging         # Staging values
        >     ```
        >
        > 2.  Syntax Rules:
        >     *   Comments must start with `#`.
        >     *   Decorators must start with `@`.
        >     *   Variable names must be uppercase with underscores.
        >     *   Values can be strings, numbers, booleans, or function calls.
        >
        > 3.  Root Level Decorators:
        >     *   `@envFlag` - Sets environment flag key.
        >     *   `@defaultRequired` - Sets default required state for all items.
        >     *   `@defaultSensitive` - Sets default sensitive state for all items.
        >
        >     Note: When using default decorators, you only need to specify item-level decorators when you want to override the default value. For example, if `@defaultRequired=true`, you don't need to add `@required` to individual items.
        >
        > 4.  Item Level Decorators:
        >     *   `@required` - Makes item required (omit if `@defaultRequired=true`).
        >     *   `@sensitive` - Marks item as sensitive (omit if `@defaultSensitive=true`).
        >     *   `@type` - Sets value type.
        >     *   `@example` - Provides example value.
        >     *   `@trim` - Trims whitespace.
        >     *   `@deindent` - Trims leading whitespace.
        >
        > 5.  Value Types:
        >     *   `string`
        >     *   `number` (integer/float)
        >     *   `boolean`
        >     *   `url`
        >     *   `email`
        >     *   `port`
        >     *   `path`
        >     *   `ip`
        >     *   `hostname`
        >     *   `uuid`
        >     *   `date`
        >
        > 6.  Function Calls:
        >     *   `varlock()` - For encrypted values.
        >     *   `fallback()` - For fallback values.
        >     *   `concat()` - For concatenated values.
        >     *   `exec()` - For command output.
        >     *   `ref()` - For referencing other variables.

**Examples:**

*   **Input:**
    ```
    # Bad: Redundant decorators with defaults
    # @defaultSensitive=true
    # @defaultRequired=true
    # ---
    # @sensitive @required
    SECRET_KEY=value

    # Good: Using defaults
    # @defaultSensitive=true
    # @defaultRequired=true
    # ---
    SECRET_KEY=value
    ```
*   **Output:** "Properly using default decorators."
*   **Input:**
    ```
    # Bad: Redundant required decorator
    # @defaultSensitive=true
    # @defaultRequired=true
    # ---
    # @sensitive=false @required
    PUBLIC_KEY=value

    # Good: Only overriding sensitive
    # @defaultSensitive=true
    # @defaultRequired=true
    # ---
    # @sensitive=false
    PUBLIC_KEY=value
    ```
*   **Output:** "Properly overriding only necessary defaults."
*   **Input:**
    ```
    # Bad: Missing type decorator
    PORT=3000

    # Good: With type decorator
    # @type=port
    PORT=3000
    ```
*   **Output:** "Environment variable with proper type."

**Metadata:**

*   **Priority:** high
*   **Version:** 1.0
