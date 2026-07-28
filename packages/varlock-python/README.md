# varlock (Python)

Native Python integration for [varlock](https://varlock.dev): load and validate your `.env.schema` from inside a running Python process, with no wrapped launch.

```bash
pip install varlock
```

Requires the varlock CLI:

```bash
brew install dmno-dev/tap/varlock
# or
curl -sSfL https://varlock.dev/install.sh | sh -s
```

## Usage

```python
import varlock

env = varlock.load()

env["DATABASE_URL"]   # also env.DATABASE_URL
env["PORT"]           # 5432, an int, not "5432"
```

`load()` resolves your schema by calling the varlock CLI, injects the resolved values into `os.environ`, and returns them coerced. When the process was started with `varlock run`, the values are already resolved, so `load()` reads them instead of resolving again. The same code works either way.

Reading a key that isn't in your schema raises `VarlockMissingKeyError` rather than returning `None`.

### Notebooks

`load()` needs no wrapped launch, so it works in a Jupyter kernel started by VS Code or JupyterLab. After editing your schema or rotating a secret, re-resolve without restarting the kernel:

```python
varlock.reload()
```

`repr(ENV)` masks values marked `@sensitive`, so echoing `env` in a cell won't write secrets into the saved notebook.

### Scripts and servers

To fail fast at startup the way `varlock run` does, import the side-effect module as early as possible:

```python
import varlock.auto_load  # noqa: F401

from varlock import ENV
```

## API

| | |
| --- | --- |
| `load(**opts)` | Resolve (or adopt already-resolved values) and return `ENV` |
| `reload(**opts)` | Re-resolve, ignoring what's loaded |
| `unload()` | Forget values and restore every env var varlock set |
| `ENV` | The resolved env, a read-only mapping with attribute access |
| `is_loaded()`, `is_running_under_varlock_run()` | State checks |
| `get_settings()`, `get_sensitive_keys()` | Schema metadata |

`load()` accepts `cwd`, `path`, `env`, `force`, `inject`, `on_error`, and `timeout`. See the docstrings.

Set `VARLOCK_BIN` to an absolute path to skip CLI discovery.

## Development

From this directory:

```bash
uv run pytest
```

Docs live in `packages/varlock-website/src/content/docs/integrations/`.
