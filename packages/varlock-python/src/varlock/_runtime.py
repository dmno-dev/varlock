"""Process-level env state.

The JS equivalent is `runtime/env.ts`: hold the resolved values, inject them into the
process environment, and let the same objects be re-initialized on reload. Values are mutated
in place rather than replaced, so anything holding a reference to `ENV` sees a reload.
"""

from __future__ import annotations

import os
from typing import Any, Dict, FrozenSet, List, Optional

from ._blob import BLOB_ENV_VAR, LoadedGraph


class EnvState:
    """Everything varlock knows about the currently loaded env."""

    def __init__(self) -> None:
        self.initialized = False
        self.values: Dict[str, Any] = {}
        self.env_strings: Dict[str, str] = {}
        self.declared_keys: List[str] = []
        self.sensitive_keys: FrozenSet[str] = frozenset()
        self.settings: Dict[str, Any] = {}
        self.errors: Optional[Dict[str, Any]] = None
        # keys we wrote into os.environ -> the value they had before (None = was not set)
        self._overwritten: Dict[str, Optional[str]] = {}

    # -- os.environ bookkeeping ----------------------------------------------------------

    def set_env_var(self, key: str, value: str) -> None:
        """Set an environment variable, remembering what was there so it can be restored."""
        if key not in self._overwritten:
            self._overwritten[key] = os.environ.get(key)
        os.environ[key] = value

    def restore_environ(self) -> None:
        """Undo every environment variable this package set."""
        for key, previous in self._overwritten.items():
            if previous is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = previous
        self._overwritten.clear()

    def clean_environ_copy(self) -> Dict[str, str]:
        """A copy of the environment with this package's injection undone.

        Used as the environment for the CLI when re-resolving, so it sees the environment as
        it was rather than the values we put there. Copied rather than applied in place, so a
        failed reload leaves the currently loaded values untouched.
        """
        clean = dict(os.environ)
        for key, previous in self._overwritten.items():
            if previous is None:
                clean.pop(key, None)
            else:
                clean[key] = previous
        return clean

    @property
    def injected_keys(self) -> List[str]:
        return [k for k in self._overwritten if k != BLOB_ENV_VAR]

    # -- (re)initialization --------------------------------------------------------------

    def init(self, graph: LoadedGraph, *, inject: bool = True) -> None:
        """Adopt a freshly loaded graph, replacing anything loaded before it."""
        # drop the previous injection first, so keys that disappeared from the schema don't
        # linger in os.environ after a reload
        self.restore_environ()

        # mutate in place - callers hold references to these objects
        self.values.clear()
        self.values.update(graph.values)
        self.env_strings.clear()
        self.env_strings.update(graph.env_strings)
        self.settings.clear()
        self.settings.update(graph.settings)
        self.declared_keys = list(graph.declared_keys)
        self.sensitive_keys = graph.sensitive_keys
        self.errors = graph.errors

        if inject and not self.settings.get("disableProcessEnvInjection"):
            for key, env_str in graph.env_strings.items():
                self.set_env_var(key, env_str)

        self.initialized = True

    def reset(self) -> None:
        """Restore the environment and forget everything loaded."""
        self.restore_environ()
        self.values.clear()
        self.env_strings.clear()
        self.settings.clear()
        self.declared_keys = []
        self.sensitive_keys = frozenset()
        self.errors = None
        self.initialized = False


#: Module-level singleton. Unlike the JS runtime (which stores state on `globalThis` because
#: bundlers can produce several copies of the module), `sys.modules` already guarantees one
#: instance per interpreter.
state = EnvState()
