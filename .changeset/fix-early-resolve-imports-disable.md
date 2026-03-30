---
"varlock": patch
---

Fix @import(enabled=...) and @disable conditions not seeing values from .env, .env.local, and env-specific files

Previously, import conditions and imported file @disable decorators were evaluated during .env.schema's initialization, before other files (.env, .env.local, .env.ENV, .env.ENV.local) were loaded. This meant that variables set in those files were not available when resolving conditions like `enabled=eq($AUTH_MODE, "azure")` or `@disable=not(eq($AUTH_MODE, "azure"))`.

Now, DirectoryDataSource loads all auto-loaded files first (registering their config items), then processes imports in a separate pass. This ensures all file values are available when import/disable conditions are evaluated.
