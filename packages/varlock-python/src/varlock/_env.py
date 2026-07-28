"""The `ENV` object."""

from __future__ import annotations

import html
from collections.abc import Mapping
from typing import Any, Dict, Iterator

from ._redact import redact_value
from ._runtime import EnvState
from .errors import VarlockMissingKeyError, VarlockNotLoadedError

_NOT_LOADED_MSG = (
    "varlock env has not been loaded yet.\n"
    "Call varlock.load() first, or start your program with `varlock run -- <command>`."
)


class Env(Mapping):
    """Resolved, coerced env values.

    Behaves like a read-only mapping (``env["KEY"]``, ``in``, ``.get()``, ``dict(env)``) and
    also allows attribute access (``env.KEY``) since that reads better in a notebook. Reading a
    key that isn't in your schema raises :class:`VarlockMissingKeyError` rather than returning
    ``None``, matching the JS ``ENV`` proxy.

    Note that mapping methods (``get``, ``keys``, ``items``, ``values``) shadow same-named env
    keys for attribute access only. Env keys are uppercase by convention, and ``env["get"]``
    always works regardless.
    """

    __slots__ = ("_state",)

    def __init__(self, state: EnvState) -> None:
        self._state = state

    # -- mapping protocol ----------------------------------------------------------------

    def __getitem__(self, key: str) -> Any:
        state = self._state
        if not state.initialized:
            raise VarlockNotLoadedError(_NOT_LOADED_MSG)
        try:
            return state.values[key]
        except KeyError:
            pass
        # a declared key with no value is a different problem than a typo, so say which it is
        if key in state.declared_keys:
            raise VarlockMissingKeyError(
                key,
                f"`{key}` exists in your schema, but has no value in this environment",
            ) from None
        raise VarlockMissingKeyError(key) from None

    def __iter__(self) -> Iterator[str]:
        return iter(self._state.values)

    def __len__(self) -> int:
        return len(self._state.values)

    def __contains__(self, key: object) -> bool:
        return key in self._state.values

    # -- attribute access ----------------------------------------------------------------

    def __getattr__(self, name: str) -> Any:
        # Private and dunder names are probed by tooling (IPython display hooks, copy, pickle)
        # and must answer with a plain AttributeError. Underscore-prefixed env keys are legal,
        # so a real one still resolves.
        if name.startswith("_"):
            # copy/pickle can build an instance without __init__, leaving the slot unset;
            # reading it below would then recurse back into __getattr__
            if name == "_state":
                raise AttributeError(name)
            state = self._state
            if state.initialized and name in state.values:
                return state.values[name]
            raise AttributeError(name)
        return self[name]

    def __dir__(self):
        # makes `ENV.<TAB>` complete env keys in notebooks and REPLs
        return sorted(set(super().__dir__()) | set(self._state.values))

    # -- display -------------------------------------------------------------------------

    def to_dict(self, *, redact_sensitive: bool = False) -> Dict[str, Any]:
        """A plain dict of the resolved values.

        Pass ``redact_sensitive=True`` to mask values marked ``@sensitive``, which is what you
        want before printing or logging the whole thing.
        """
        if not redact_sensitive:
            return dict(self._state.values)
        sensitive = self._state.sensitive_keys
        return {
            key: (redact_value(value) if key in sensitive else value)
            for key, value in self._state.values.items()
        }

    def __repr__(self) -> str:
        if not self._state.initialized:
            return "<varlock.Env (not loaded)>"
        # never render sensitive values here: a notebook echoes the repr of the last
        # expression in a cell, which would otherwise print every secret into the saved file
        inner = ", ".join(
            f"{key}={value!r}" for key, value in self.to_dict(redact_sensitive=True).items()
        )
        return f"<varlock.Env {inner}>"

    def _repr_html_(self) -> str:
        """Rendered by Jupyter in place of the repr."""
        if not self._state.initialized:
            return "<em>varlock.Env (not loaded)</em>"
        sensitive = self._state.sensitive_keys
        rows = []
        for key, value in self.to_dict(redact_sensitive=True).items():
            marker = " 🔐" if key in sensitive else ""
            rows.append(
                "<tr>"
                f"<td style='text-align:left'><code>{html.escape(key)}</code>{marker}</td>"
                f"<td style='text-align:left'><code>{html.escape(repr(value))}</code></td>"
                "</tr>"
            )
        unset = [k for k in self._state.declared_keys if k not in self._state.values]
        footer = (
            f"<caption style='caption-side:bottom;text-align:left'>{len(unset)} declared "
            "key(s) with no value in this environment</caption>"
            if unset
            else ""
        )
        return (
            "<table>"
            f"{footer}"
            "<thead><tr><th style='text-align:left'>key</th>"
            "<th style='text-align:left'>value</th></tr></thead>"
            f"<tbody>{''.join(rows)}</tbody></table>"
        )
