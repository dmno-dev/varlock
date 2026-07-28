"""Finding and masking sensitive values in arbitrary data.

Mirrors `resetRedactionMap` / `redactSensitiveConfig` / `scanForLeaks` in the JS runtime, so
the same values are caught and masked identically in both languages.

Only *string* values are registered for redaction, matching the JS runtime. A sensitive value
that resolved to a number would otherwise have every occurrence of that number masked
everywhere, which is far more disruptive than it is useful.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

from ._blob import LoadedGraph
from ._redact import redact_string
from .errors import VarlockLeakError

#: Wraps a value that was deliberately revealed, so redaction leaves it alone.
UNMASK_STR = "👁"

# deep structures are redacted recursively; the bound stops a cyclic object (which the JS
# implementation hits as a JSON.stringify failure) from blowing the stack
_MAX_DEPTH = 12


class _Entry:
    __slots__ = ("key", "masked", "prevent_leaks")

    def __init__(self, key: str, masked: str, prevent_leaks: bool) -> None:
        self.key = key
        self.masked = masked
        self.prevent_leaks = prevent_leaks


class RedactionState:
    def __init__(self) -> None:
        self.sensitive: Dict[str, _Entry] = {}
        self.pattern: Optional[re.Pattern] = None

    @property
    def active(self) -> bool:
        return self.pattern is not None


state = RedactionState()


def _collect_strings(value: Any, collected: List[str], depth: int = 0) -> None:
    """Every redactable string inside a (possibly composite) sensitive value.

    Each string element of an array/object registers on its own, so leaking a single element
    is caught, not just the whole serialized value.
    """
    if depth > _MAX_DEPTH:
        return
    if isinstance(value, str):
        if value:
            collected.append(value)
    elif isinstance(value, (list, tuple, set, frozenset)):
        for item in value:
            _collect_strings(item, collected, depth + 1)
    elif isinstance(value, dict):
        for item in value.values():
            _collect_strings(item, collected, depth + 1)


def reset(graph: LoadedGraph) -> None:
    """Rebuild the redaction map from a freshly loaded graph."""
    state.sensitive = {}
    state.pattern = None

    for key in graph.sensitive_keys:
        if key not in graph.values:
            continue
        strings: List[str] = []
        _collect_strings(graph.values[key], strings)
        # the flat serialized form registers too: a JSON-encoded element may not match its
        # raw form once escaped
        env_str = graph.env_strings.get(key)
        if env_str:
            strings.append(env_str)
        prevent_leaks = graph.prevent_leaks.get(key, True)
        for sensitive_str in strings:
            masked = redact_string(sensitive_str)
            if masked:
                state.sensitive[sensitive_str] = _Entry(key, masked, prevent_leaks)

    if not state.sensitive:
        return

    # sort longest first so overlapping values match maximally
    alternatives = "|".join(
        re.escape(s) for s in sorted(state.sensitive, key=len, reverse=True)
    )
    state.pattern = re.compile(
        f"({UNMASK_STR} )?({alternatives})( {UNMASK_STR})?"
    )


def clear() -> None:
    state.sensitive = {}
    state.pattern = None


def _replace(match: "re.Match") -> str:
    pre, value, post = match.group(1), match.group(2), match.group(3)
    # both markers present means the value was deliberately revealed, so leave it as it is
    if pre and post:
        return match.group(0)
    return state.sensitive[value].masked


def redact(value: Any) -> Any:
    """Mask every sensitive value found anywhere in `value`.

    Strings are masked directly; lists, tuples, sets, and dicts are walked and rebuilt.
    Anything else is returned unchanged. Must be called after values are loaded.
    """
    if not state.active:
        return value
    return _redact(value, 0)


def _redact(value: Any, depth: int) -> Any:
    if depth > _MAX_DEPTH:
        return value
    if isinstance(value, str):
        return state.pattern.sub(_replace, value)
    if isinstance(value, dict):
        return {
            _redact(k, depth + 1): _redact(v, depth + 1) for k, v in value.items()
        }
    if isinstance(value, list):
        return [_redact(item, depth + 1) for item in value]
    if isinstance(value, tuple):
        return tuple(_redact(item, depth + 1) for item in value)
    if isinstance(value, (set, frozenset)):
        return type(value)(_redact(item, depth + 1) for item in value)
    return value


def reveal(secret: str) -> str:
    """Mark a sensitive value so redaction leaves it alone when it is printed.

    Returns the value unchanged when redaction is not active.
    """
    if not state.active:
        return secret
    return f"{UNMASK_STR} {secret} {UNMASK_STR}"


def scan_for_leaks(
    value: Any, *, method: Optional[str] = None, file: Optional[str] = None
) -> Any:
    """Raise if `value` contains a sensitive value, otherwise return it unchanged.

    Use it on anything about to leave your process (a response body, a file you are writing,
    a payload headed for a third party). Items opted out with `@sensitive={preventLeaks=false}`
    are skipped, though they are still masked in logs.
    """
    if not state.sensitive or value is None:
        return value

    if isinstance(value, (bytes, bytearray, memoryview)):
        text = bytes(value).decode("utf-8", errors="replace")
    elif isinstance(value, str):
        text = value
    else:
        return value

    for sensitive_str, entry in state.sensitive.items():
        if not entry.prevent_leaks:
            continue
        if sensitive_str in text:
            location = "".join(
                [
                    f"\n> Scan method: {method}" if method else "",
                    f"\n> File: {file}" if file else "",
                ]
            )
            raise VarlockLeakError(
                f"🚨 DETECTED LEAKED SENSITIVE CONFIG - {entry.key}"
                f"\n> Config item key: {entry.key}{location}",
                key=entry.key,
            )
    return value
