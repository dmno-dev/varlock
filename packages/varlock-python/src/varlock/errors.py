"""Error types raised by varlock.

All of them derive from :class:`VarlockError`, so ``except varlock.VarlockError`` catches
everything this package raises.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

__all__ = [
    "VarlockError",
    "VarlockBinaryNotFoundError",
    "VarlockLoadError",
    "VarlockNotLoadedError",
    "VarlockMissingKeyError",
    "VarlockLeakError",
]


class VarlockError(Exception):
    """Base class for every error raised by varlock."""


class VarlockBinaryNotFoundError(VarlockError):
    """The varlock CLI could not be found.

    The Python package resolves values by calling the CLI, so it has to be installed and
    findable. :attr:`searched` lists every location that was checked.
    """

    def __init__(self, message: str, searched: Optional[list] = None) -> None:
        super().__init__(message)
        self.searched = searched or []


class VarlockLoadError(VarlockError):
    """Loading or validating the env schema failed.

    :attr:`stderr` holds the CLI's own (already formatted) output, which is normally the most
    useful thing to show a user. On a validation failure the CLI still emits the serialized
    graph, so :attr:`partial_values` carries whichever values did resolve, and :attr:`errors`
    carries the structured per-item and root errors.
    """

    def __init__(
        self,
        message: str,
        *,
        stderr: str = "",
        stdout: str = "",
        exit_code: int = 1,
        errors: Optional[Dict[str, Any]] = None,
        partial_values: Optional[Dict[str, Any]] = None,
    ) -> None:
        super().__init__(message)
        self.stderr = stderr
        self.stdout = stdout
        self.exit_code = exit_code
        self.errors = errors
        self.partial_values = partial_values or {}

    def __str__(self) -> str:
        # the CLI already formats its errors nicely, so lead with the message and append that
        # output verbatim rather than re-wording it
        base = super().__str__()
        detail = self.stderr.strip()
        return f"{base}\n\n{detail}" if detail else base


class VarlockNotLoadedError(VarlockError):
    """``ENV`` was accessed before any values were loaded."""


class VarlockLeakError(VarlockError):
    """A sensitive value was found in something on its way out of the process."""

    def __init__(self, message: str, *, key: str) -> None:
        super().__init__(message)
        #: The config item whose value leaked.
        self.key = key


class VarlockMissingKeyError(VarlockError, KeyError, AttributeError):
    """A key that is not in your schema was read off ``ENV``.

    Inherits from both :class:`KeyError` and :class:`AttributeError` so that ``env["NOPE"]``
    and ``env.NOPE`` can each be caught the way the corresponding Python protocol implies.
    """

    def __init__(self, key: str, message: Optional[str] = None) -> None:
        self.key = key
        super().__init__(message or f"`{key}` does not exist in your env schema")

    def __str__(self) -> str:
        # KeyError.__str__ would wrap the message in quotes (repr of args[0])
        return self.args[0] if self.args else ""
