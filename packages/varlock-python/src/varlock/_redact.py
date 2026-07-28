"""Value masking.

Mirrors `redactString` in the JS runtime so masked values look the same everywhere varlock
shows them. Full log redaction (patching `logging` and `print`) is separate; this module only
covers masking a single value, which is what `repr(ENV)` needs.
"""

from __future__ import annotations

from typing import Any

MASK_CHAR = "▒"


def redact_string(value: str, *, mode: str = "show_first_2", hide_length: bool = True) -> str:
    """Mask a string, e.g. ``"hunter2"`` -> ``"hu▒▒▒▒▒"``.

    ``hide_length`` keeps the mask a fixed width so the output doesn't leak how long the
    original value was.
    """
    if not value:
        return value
    hidden_length = 5 if hide_length else max(len(value) - 2, 0)
    hidden = MASK_CHAR * hidden_length
    if mode == "show_last_2":
        return f"{hidden}{value[-2:]}"
    if mode == "show_first_last":
        return f"{value[:1]}{hidden}{value[-1:]}"
    return f"{value[:2]}{hidden}"


def redact_value(value: Any) -> str:
    """Mask any resolved value for display, including non-strings."""
    if isinstance(value, str):
        return redact_string(value)
    # composites and scalars alike: mask the rendered form rather than showing structure
    return redact_string(str(value))
