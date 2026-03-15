# Copilot Rules for Varlock

## 🚨 NEVER COMPLETE A TASK WITHOUT DOING THESE STEPS

### 1. Always Run the Linter
```bash
bun run lint:fix
```
- Run this command from the repo root after ANY code change
- Fix any remaining lint errors manually
- **NEVER** leave lint errors unresolved
- **If bun fails**: Use `npm install && npm run lint:fix` as fallback

### 2. Always Add a Changeset
```bash
bun run changeset:add
```
- Every PR NEEDS a changeset
- If only internal changes (docs, CI, tests, config) you can use an empty changeset
- IF the work affects any published packages, select them
- Choose the correct version bump type (patch/minor/major)
- Write a clear, user-facing description
- **If bun fails**: Use `npm run changeset:add` as fallback

Example changeset:
```
---
"varlock": patch
"@varlock/vite-integration": patch
---

concise explanation of the change
```

Example _empty_ changeset:
```
---
---
```

### 3. Always Verify the Build
```bash
bun run build:libs
```
- Ensure all packages build successfully
- Fix any TypeScript or build errors
- **If bun fails**: Use `npm run build:libs` as fallback

## Quick Reference Commands

| Task | Command | When |
|------|---------|------|
| Lint & Fix | `bun run lint:fix` | After every code change |
| Add Changeset | `bun run changeset:add` | When changing published packages |
| Build Check | `bun run build:libs` | Before completing any task |
| Run Tests | `bun run test:ci` | When changing logic |

## What Requires a Changeset?

### ✅ REQUIRES Changeset:
- Bug fixes in published packages
- New features in published packages  
- Breaking changes
- API changes
- Dependency updates that affect users

### ❌ Empty Changeset OK:
- Documentation updates
- Test file changes
- Internal scripts/tooling
- CI/CD configuration
- Development-only dependencies

## Common Mistakes to Avoid

1. **Forgetting to lint** - Always run `bun run lint:fix`
2. **Skipping changesets** - When in doubt, add one
3. **Not testing the build** - Always verify with `bun run build:libs`
4. **Wrong changeset type** - Be conservative (patch > minor > major)
5. **Unclear changeset description** - Write for end users, not developers

## Troubleshooting

### Preventing `bun install` Failures

Common causes and fixes:

1. **Registry Configuration Issues:**
   ```bash
   bun config set registry https://registry.npmjs.org/
   ```

2. **Network/Proxy Issues:**
   ```bash
   # If behind corporate firewall/proxy
   bun config set proxy http://your-proxy:port
   bun config set https-proxy http://your-proxy:port
   ```

3. **Certificate Issues:**
   ```bash
   # Disable strict SSL if needed (not recommended for production)
   bun config set strict-ssl false
   ```

4. **Cache Corruption:**
   ```bash
   # Clear cache regularly
   bun pm cache rm
   ```

5. **Use .bunfig.toml for persistent settings:**
   ```toml
   [install]
   registry = "https://registry.npmjs.org/"
   cache = false  # Disable cache if causing issues
   ```

### If `bun install` Still Fails

Try these solutions in order:

1. **Update Bun to latest version:**
   ```bash
   curl -fsSL https://bun.sh/install | bash
   source ~/.bashrc  # or restart terminal
   ```

2. **Clear Bun cache:**
   ```bash
   bun pm cache rm
   ```

3. **Delete node_modules and reinstall:**
   ```bash
   rm -rf node_modules bun.lockb
   bun install
   ```

4. **Check registry access:**
   ```bash
   bun config get registry  # Should show https://registry.npmjs.org/
   ```

5. **If still failing, use npm as fallback:**
   ```bash
   npm install
   npm run lint:fix
   ```

### If Linter Isn't Available

1. **Ensure dependencies are installed:**
   ```bash
   bun install  # or npm install
   ```

2. **Run linter directly with bunx/npx:**
   ```bash
   bunx eslint . --fix  # or npx eslint . --fix
   ```

---

**Remember**: These are MANDATORY steps, not suggestions. Following these rules ensures code quality and proper release management.