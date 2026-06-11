# Smoke Tests

This document describes the smoke testing setup for varlock to ensure cross-platform compatibility.

## Overview

Varlock includes both local and CI smoke tests to verify that the core functionality works correctly across different platforms (Windows, macOS, Linux).

## When Smoke Tests Run

### GitHub Actions (CI)
The full cross-platform smoke test suite runs automatically on **release PRs only** (PRs created by bumpy with "Versioned release" in the title). This prevents slowing down regular development while ensuring thorough testing before releases.

**Workflow:** `.github/workflows/smoke-test.yaml`

**Platforms tested:**
- Ubuntu Latest (Linux)
- macOS Latest
- Windows Latest

**Runtimes tested:**
- Node.js 24.x
- Bun (latest)

### Local Testing
You can run smoke tests locally on your current platform:

```bash
bun run smoke-test
```

**Script:** `scripts/smoke-test.sh`

## What Gets Tested

### 1. Build Tests
- Building the main varlock package
- Building vite integration
- Building astro integration
- Verifying all build artifacts exist

### 2. Core Varlock Tests
- `varlock --help` - CLI help command
- `varlock load` - Loading environment variables from schema
- `varlock run` - Running commands with injected environment variables

### 3. Command Execution Tests
- `varlock run -- node --version` (basic command execution)
- `varlock run -- bun --version` (verifies Bun runtime compatibility)
- Command not found error handling
- Script execution with shebangs (Unix)
- Batch file execution (Windows)

### 4. Log Redaction Tests
- **Basic redaction**: Verifies secrets are redacted in console.log output
- **Interactive script redaction**: Verifies secrets are redacted in:
  - stdout and stderr streams
  - Multiple writes to the same stream
  - Interleaved stdout/stderr output
  - Secrets embedded in longer strings (e.g., connection strings)
- **Stdin availability**: Verifies that redaction doesn't break stdin access
  - stdin.isTTY property remains accessible
  - stdin.readable property remains accessible
  - Tools that check stdin properties can still run
- **Cross-runtime redaction**: Verifies redaction works with both Node.js and Bun

**Note on TTY detection**: Redaction is auto-detected per stream — output attached to an interactive terminal passes through directly (preserving raw TTY behavior for tools like `psql` or `claude`), while piped/redirected output goes through the redaction filter. Since the smoke tests capture output (non-TTY), redaction is always active there. The stdin test verifies that stdin properties remain accessible even when stdout/stderr are piped.

### 5. Framework Integration Tests
- **Next.js Integration**: Builds a minimal Next.js site with `@varlock/nextjs-integration` and verifies:
  - Static export build completes successfully
  - Public env vars (e.g., `NEXT_PUBLIC_API_URL`) are injected into the build output
  - Site renders correctly with varlock configuration

> **Note:** Astro integration tests have been moved to the `framework-tests/` directory for more comprehensive coverage (see `framework-tests/frameworks/astro/`).

### 6. Runtime Compatibility Tests
- **Node.js**: Verifies varlock works with Node.js, including log redaction
- **Bun**: Verifies varlock works with Bun runtime, including log redaction

### 7. Cross-Platform Edge Cases

#### Windows-Specific Tests
- **PATHEXT handling**: Tests various executable extensions (.exe, .cmd, .bat, .com)
- **Batch file execution**: Ensures .cmd and .bat files execute correctly via cmd.exe
- **PATH with spaces**: Tests executables in directories with spaces (common on Windows)
- **Command not found on Windows**: Verifies ENOENT error detection (Windows exit code 1 special case)

#### Unix-Specific Tests
- **Shebang execution**: Tests scripts with `#!/usr/bin/env node`
- **Executable permissions**: Tests files marked with `chmod +x`

### 8. PATH Resolution Tests
- Current working directory (Windows)
- Quoted PATH entries (directories with spaces)
- Case-insensitive extension matching (Windows)

## Why These Tests Matter

The smoke tests verify critical fixes made to handle cross-platform command execution:

1. **Windows CWD Search**: Commands in current directory are found on Windows
2. **PATHEXT Support**: All Windows executable types are recognized
3. **Shell Wrapping**: .cmd/.bat files execute via cmd.exe automatically
4. **Quoted Paths**: Handles PATH entries with spaces correctly
5. **ENOENT Detection**: Proper "command not found" errors on Windows
6. **Shebang Support**: Scripts with shebangs work on Unix systems

## Manual Trigger

You can manually trigger the full cross-platform test suite via GitHub Actions:

1. Go to Actions tab in GitHub
2. Select "Cross-Platform Smoke Tests" workflow
3. Click "Run workflow"
4. Choose the branch to test

## Adding New Tests

To add a new smoke test:

### For CI (all platforms):
Edit `.github/workflows/smoke-test.yaml` and add a new step.

### For local testing:
Edit `scripts/smoke-test.sh` and add a new test section.

### Guidelines:
- Keep tests fast (< 30 seconds each)
- Test real-world scenarios that users will encounter
- Focus on cross-platform edge cases
- Include clear success/failure messages
- Use appropriate shell for the platform (bash/pwsh)

## Known Limitations

### Interactive Tools and TTY Detection

Redaction is auto-detected per output stream. When a stream is attached to an interactive terminal, it is inherited directly (`stdio: 'inherit'`), so interactive CLIs that check `process.stdout.isTTY` (e.g., `psql`, `mysql`, `claude`), prompts, progress bars, and spinners all work without any flags. When a stream is piped or redirected (as in the smoke tests and CI), it goes through the redaction filter and the child won't see it as a TTY.

To override the auto-detection:
```bash
varlock run --no-redact-stdout -- node app.js > log.txt  # force-disable redaction even when piped
varlock run --redact-stdout -- node app.js > log.txt     # force redaction of piped output (e.g., @redactLogs=false)
```

`--redact-stdout` errors if output is attached to an interactive terminal — redacting a TTY-attached stream requires piping it, which would break TTY-dependent tools.

**Important**: stdin is always inherited (even with redaction enabled), so tools can read user input. The limitation is specifically about stdout/stderr TTY detection when output is piped.

## Troubleshooting

### Tests fail on Windows but pass on Unix
Check:
- PATHEXT environment variable handling
- Path separator usage (`\` vs `/`)
- Shell wrapping for .cmd/.bat files
- Case sensitivity in file extensions

### Tests fail on macOS but pass elsewhere
Check:
- File permissions (executable bit)
- PATH differences
- Shebang interpretation

### Tests pass locally but fail in CI
Check:
- CI environment PATH differences
- Installed tools availability
- Working directory assumptions

## Related Files

- **Workflow**: `.github/workflows/smoke-test.yaml`
- **Local script**: `scripts/smoke-test.sh`
- **Exec implementation**: `packages/varlock/src/lib/exec.ts`
- **Process utilities**: `packages/varlock/src/lib/process.ts`
- **Debug utility**: `packages/varlock/src/lib/debug.ts`
