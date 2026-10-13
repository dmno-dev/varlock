---
varlock: minor
---

Python codegen: `@generatePythonEnv` now emits a lazily loaded `ENV` object with a documented property per item, so editors show item descriptions, `@docs()` links and deprecations on hover where values are read. `Env` TypedDict fields get docstrings instead of `#` comments.
