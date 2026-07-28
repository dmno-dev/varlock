"""varlock: AI-safe .env files.

Resolve and validate your env schema from inside a running Python process, with no wrapped
launch and no subprocess boilerplate::

    import varlock

    env = varlock.load()
    env["DATABASE_URL"]

The same call also works when the program was started with ``varlock run``: the values are
already in the environment, so :func:`load` reads them instead of resolving again.

See https://varlock.dev/integrations/python/
"""

from __future__ import annotations

import os
import sys
from typing import Any, Dict, FrozenSet, Optional, Sequence, Union

from ._binary import BIN_PATH_ENV_VAR, clear_cache as clear_binary_cache, find_binary
from ._blob import BLOB_ENV_VAR, RUN_FLAG_ENV_VAR, parse_blob
from ._cli import PathArg, run_load
from ._env import Env
from ._runtime import state as _state
from .errors import (
    VarlockBinaryNotFoundError,
    VarlockError,
    VarlockLoadError,
    VarlockMissingKeyError,
    VarlockNotLoadedError,
)

try:  # pragma: no cover - depends on install method
    from importlib.metadata import PackageNotFoundError, version as _pkg_version

    __version__ = _pkg_version("varlock")
except Exception:  # pragma: no cover
    __version__ = "0.0.0+unknown"

__all__ = [
    "ENV",
    "Env",
    "load",
    "reload",
    "unload",
    "is_loaded",
    "is_running_under_varlock_run",
    "get_settings",
    "get_sensitive_keys",
    "find_binary",
    "clear_binary_cache",
    "VarlockError",
    "VarlockBinaryNotFoundError",
    "VarlockLoadError",
    "VarlockMissingKeyError",
    "VarlockNotLoadedError",
    "BIN_PATH_ENV_VAR",
    "__version__",
]

#: The resolved env. Populated by :func:`load`, and automatically on import when the process
#: was started with ``varlock run``.
ENV = Env(_state)


def load(
    *,
    cwd: Optional[PathArg] = None,
    path: Optional[Union[PathArg, Sequence[PathArg]]] = None,
    env: Optional[str] = None,
    force: bool = False,
    inject: bool = True,
    on_error: str = "raise",
    timeout: Optional[float] = None,
) -> Env:
    """Load, validate, and return the resolved env.

    Cheap to call repeatedly: once values are loaded (or the process was started with
    ``varlock run``) this returns the existing :data:`ENV` without doing any work. Use
    ``force=True`` (or :func:`reload`) to resolve again.

    Args:
        cwd: Directory to resolve the schema from. Defaults to the current working directory,
            which in a notebook is the directory the notebook lives in.
        path: One or more `.env` files or directories to use as the entry point, matching the
            CLI's ``--path``.
        env: Environment name to load for, matching the CLI's ``--env``. Ignored if your
            schema sets ``@currentEnv``.
        force: Re-resolve even if values are already loaded.
        inject: Also set the resolved values as environment variables, so libraries reading
            ``os.environ`` and any subprocesses you spawn see them. Honors
            ``@disableProcessEnvInjection``.
        on_error: ``"raise"`` (default) raises :class:`VarlockLoadError`. ``"exit"`` prints
            the CLI's error output and exits, matching what ``varlock run`` does. Prefer the
            default in notebooks and long-lived processes.
        timeout: Seconds to wait for the CLI. ``None`` (default) waits indefinitely, which
            matters when a plugin needs you to approve a biometric prompt.

    Returns:
        The :data:`ENV` object.

    Raises:
        VarlockLoadError: if loading or validation failed.
        VarlockBinaryNotFoundError: if the varlock CLI isn't installed.
    """
    try:
        return _load(
            cwd=cwd, path=path, env=env, force=force, inject=inject, timeout=timeout
        )
    except VarlockError as err:
        if on_error == "exit":
            _exit_with(err)
        raise


def _load(
    *,
    cwd: Optional[PathArg],
    path: Optional[Union[PathArg, Sequence[PathArg]]],
    env: Optional[str],
    force: bool,
    inject: bool,
    timeout: Optional[float],
) -> Env:
    if not force:
        if _state.initialized:
            return ENV
        # started via `varlock run` (or a previous load in this process): the values are
        # already resolved and sitting in the environment, so don't resolve them again
        blob = os.environ.get(BLOB_ENV_VAR)
        if blob:
            _state.init(parse_blob(blob), inject=inject)
            return ENV

    # hand the CLI the environment as it was before we injected anything, so a reload
    # re-resolves against the caller's env rather than against our own values. Undone in a
    # copy rather than in place, so a failed reload leaves what's loaded now untouched.
    stdout = run_load(
        version=__version__,
        cwd=cwd,
        path=path,
        env=env,
        timeout=timeout,
        base_env=_state.clean_environ_copy(),
    )
    graph = parse_blob(stdout)
    _state.init(graph, inject=inject)

    # Publish the blob so subprocesses (and any generated env module) see the same values,
    # matching `varlock run`. Skipped when values aren't being injected: that is the case
    # where `@encryptInjectedEnv` would have the CLI encrypt the blob, and this package has no
    # decryption, so keeping it in memory only is safer than writing plaintext.
    if inject and not graph.settings.get("disableProcessEnvInjection"):
        _state.set_env_var(BLOB_ENV_VAR, stdout)

    return ENV


def reload(**kwargs: Any) -> Env:
    """Re-resolve everything, ignoring what's already loaded.

    Use this after editing your schema or rotating a secret in a long-lived process such as a
    notebook kernel. Accepts the same arguments as :func:`load`.
    """
    kwargs["force"] = True
    return load(**kwargs)


def unload() -> None:
    """Forget the loaded env and restore every environment variable varlock set."""
    _state.reset()


def is_loaded() -> bool:
    """Whether env values are currently loaded."""
    return _state.initialized


def is_running_under_varlock_run() -> bool:
    """Whether this process was started with ``varlock run``."""
    return bool(os.environ.get(RUN_FLAG_ENV_VAR))


def get_settings() -> Dict[str, Any]:
    """Varlock settings from the schema's root decorators (``redactLogs`` and friends)."""
    return dict(_state.settings)


def get_sensitive_keys() -> FrozenSet[str]:
    """Keys whose values are marked ``@sensitive``."""
    return _state.sensitive_keys


def _exit_with(err: VarlockError) -> None:
    # the CLI already formats its errors, so print that output rather than a Python traceback
    detail = getattr(err, "stderr", "") or str(err)
    if detail and not detail.endswith("\n"):
        detail += "\n"
    sys.stderr.write(detail)
    raise SystemExit(getattr(err, "exit_code", 1))


def _auto_init() -> None:
    """Adopt an already-injected blob at import time.

    Mirrors the JS runtime: when the process was started with ``varlock run`` the values are
    right there, so ``from varlock import ENV`` works without an explicit load. Failures are
    swallowed here (an encrypted or malformed blob), leaving a later explicit :func:`load` to
    report the problem properly.
    """
    blob = os.environ.get(BLOB_ENV_VAR)
    if not blob:
        return
    try:
        _state.init(parse_blob(blob))
    except VarlockError:
        pass


_auto_init()
