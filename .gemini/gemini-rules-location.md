---
description: Gemini Rules Location
globs: ["*.md"]
---
# Gemini Rules Location

Rules for placing and organizing Gemini rule files in the repository.

## Rule: gemini_rules_location

**Description:** Standards for placing Gemini rule files in the correct directory.

**Filters:**

*   **File Extension:** Matches any `.md` files.
*   **Content:** Matches files that look like Gemini rules.
*   **Event:** Matches file creation events.

**Actions:**

*   **Reject:**
    *   **Condition:** `^(?!\.\/\.gemini\/.*\.md$)`
    *   **Message:** "Gemini rule files (.md) must be placed in the .gemini directory."
*   **Suggest:**
    *   **Message:**
        > When creating Gemini rules:
        >
        > 1.  Always place rule files in `PROJECT_ROOT/.gemini/`:
        >     ```
        >     .gemini/
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
        >     ├── .gemini/
        >     │   ├── your-rule-name.md
        >     │   └── ...
        >     └── ...
        >     ```
        >
        > 4.  Never place rule files:
        >     *   In the project root.
        >     *   In subdirectories outside `.gemini`.
        >     *   In any other location.

**Examples:**

*   **Input:**
    ```
    # Bad: Rule file in wrong location
    rules/my-rule.md
    my-rule.md
    .rules/my-rule.md

    # Good: Rule file in correct location
    .gemini/my-rule.md
    ```
*   **Output:** "Correctly placed Gemini rule file."

**Metadata:**

*   **Priority:** high
*   **Version:** 1.0
