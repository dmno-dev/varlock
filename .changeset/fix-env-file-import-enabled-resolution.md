---
"varlock": patch
---

Fix: variables from `.env` file were not loaded when used in `@import enabled` conditions in `.env.schema`.

When a root `@import` decorator used a config item reference in its `enabled` parameter (e.g. `@import(./.env.azure.schema, enabled=eq($AUTH_MODE, azure))`), the item was resolved using only the schema default value rather than the value from the `.env` file.

This was caused by the `.env.schema`'s `@import` processing running before the `.env` file had been loaded. The fix defers the schema's `@import` processing until after `.env` and `.env.local` have been loaded, ensuring their values are available for early resolution of `enabled` conditions.
