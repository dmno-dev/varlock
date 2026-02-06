# Pull Request Guidelines for Copilot Agent

This document provides guidelines for the Copilot agent when creating pull requests for the varlock repository.

## Required Tasks for Feature PRs

When implementing a new feature or making significant changes, the PR should include:

### 1. Code Implementation
- Implement the feature with minimal, surgical changes
- Follow existing code patterns and conventions
- Add appropriate error handling

### 2. Tests
- Add comprehensive test coverage for the new feature
- Ensure all existing tests still pass
- Test edge cases and error scenarios

### 3. Documentation Updates
- Update relevant documentation in `packages/varlock-website/src/content/docs/`
- Add examples showing how to use the new feature
- Update reference documentation if adding new decorators, functions, or parameters
- Common documentation files to update:
  - `/guides/*.mdx` - Feature guides and tutorials
  - `/reference/*.mdx` - API reference documentation

### 4. Changeset
- **Always** create a changeset file in `.changeset/` directory
- Use semantic versioning: `minor` for new features, `patch` for bug fixes, `major` for breaking changes
- Include clear description of the changes
- Provide usage examples in the changeset
- Format: Create a new `.md` file in `.changeset/` with:
  ```markdown
  ---
  "varlock": <minor|patch|major>
  ---
  
  Brief description of the change
  
  **Details about the change**
  - Key feature 1
  - Key feature 2
  
  **Example usage:**
  \`\`\`env-spec
  # Example code here
  \`\`\`
  ```

### 5. Code Review
- Run the code review tool before finalizing
- Address any feedback from automated reviews

### 6. Security Checks
- Run CodeQL security scanner
- Fix any discovered vulnerabilities
- Include security summary in PR

## Changeset Commands

Available commands (defined in root `package.json`):
- `pnpm run changeset:add` - Interactively create a changeset (not available in CI)
- `pnpm run changeset:version` - Bundle changesets into version bumps
- `pnpm run changeset:publish` - Publish packages to npm

## Documentation Structure

The documentation website is in `packages/varlock-website/`:
- `src/content/docs/guides/` - Feature guides and how-tos
- `src/content/docs/reference/` - API reference documentation
- `src/content/docs/integrations/` - Integration guides

When updating documentation:
- Use proper markdown/MDX formatting
- Include code examples with syntax highlighting
- Link to related documentation using relative paths
- Keep examples concise and focused

## Common Mistakes to Avoid

1. ❌ Don't commit test files or temporary files (e.g., `.env.dev`, `.env.prod`)
2. ❌ Don't skip creating a changeset for user-facing changes
3. ❌ Don't forget to update documentation when adding new features
4. ❌ Don't leave empty commits or unnecessary files in the PR
5. ❌ Don't forget to run tests after making changes

## Checklist for Feature PRs

- [ ] Code implemented with minimal changes
- [ ] Tests added and all tests passing
- [ ] Documentation updated (guides and/or reference)
- [ ] Changeset created
- [ ] Code review completed
- [ ] Security checks passed
- [ ] No temporary or test files committed
