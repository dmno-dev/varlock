---
description: Claude Rules Location
globs: ["*.md"]
---
# Claude Rules Location

Rules for placing and organizing Claude rule files in the repository.

## Rule: claude_rules_location

**Description:** Standards for placing Claude rule files in the correct directory.

**Filters:**

*   **File Extension:** Matches any `.md` files.
*   **Content:** Matches files that look like Claude rules.
*   **Event:** Matches file creation events.

**Actions:**

*   **Reject:**
    *   **Condition:** `^(?!\.\/\.claude\/.*\.md$)`
    *   **Message:** "Claude rule files (.md) must be placed in the .claude directory."
*   **Suggest:**
    *   **Message:**
        > When creating Claude rules:
        >
        > 1.  Always place rule files in `PROJECT_ROOT/.claude/`:
        >     ```
        >     .claude/
        >     ├── your-rule-name.md
        >     ├── another-rule.md
        >     └── ...
        >     ```
        >
        > 2.  Follow the naming convention:
        >     *   Use kebab-case for filenames.
        >     *   Always use the `.md` extension.
        >     *   Make names descriptive of the rule's purpose.
        >
        > 3.  Directory structure:
        >     ```
        >     PROJECT_ROOT/
        >     ├── .claude/
        >     │   ├── your-rule-name.md
        >     │   └── ...
        >     └── ...
        >     ```
        >
        > 4.  Never place rule files:
        >     *   In the project root.
        >     *   In subdirectories outside `.claude`.
        >     *   In any other location.

**Examples:**

*   **Input:**
    ```
    # Bad: Rule file in wrong location
    rules/my-rule.md
    my-rule.md
    .rules/my-rule.md

    # Good: Rule file in correct location
    .claude/my-rule.md
    ```
*   **Output:** "Correctly placed Claude rule file."

**Metadata:**

*   **Priority:** high
*   **Version:** 1.0
