"""Routing output through redaction.

The JS runtime patches the console. Python has three separate places output escapes, so this
covers all of them:

- `logging`, via the record factory, which every logger and handler goes through no matter
  when it was created
- `print()`, via `builtins.print`, which resolves its stream at call time and so keeps working
  when something replaces `sys.stdout` after this ran
- direct `sys.stdout.write` / `sys.stderr.write` calls, via the stream objects themselves
- notebook cell output, via IPython's display formatter, which does not go through stdout

None of this is foolproof, the same caveat the JS integration carries. Code holding its own
reference to a stream, writing to `sys.stdout.buffer`, or rendering a secret in an object's
`__str__` after redaction has run will still get through.
"""

from __future__ import annotations

import builtins
import logging
import sys
from typing import Any, Optional

from ._redaction import redact

_logging_patch: Optional[Any] = None
_print_patch: Optional[Any] = None
# stream name -> (stream object, original write, patched write, whether it had its own `write`)
_patched_streams: dict = {}
_patched_formatter: Optional[Any] = None


# -- logging -----------------------------------------------------------------------------


def patch_logging() -> None:
    """Redact every log record at creation.

    Patching the record factory rather than adding a filter means it applies to every logger
    and every handler, including ones created after this runs. A filter would only cover the
    logger or handler it was attached to.
    """
    global _logging_patch
    if _logging_patch is not None:
        return
    original = logging.getLogRecordFactory()

    def factory(*args: Any, **kwargs: Any) -> logging.LogRecord:
        record = original(*args, **kwargs)
        record.msg = redact(record.msg)
        if record.args:
            record.args = redact(record.args)
        return record

    factory._varlock_patched = True  # type: ignore[attr-defined]
    logging.setLogRecordFactory(factory)
    _logging_patch = (original, factory)


def unpatch_logging() -> None:
    global _logging_patch
    if _logging_patch is None:
        return
    original, factory = _logging_patch
    # someone may have installed their own factory on top of ours; restoring the old one
    # would silently drop theirs
    if logging.getLogRecordFactory() is factory:
        logging.setLogRecordFactory(original)
    _logging_patch = None


# -- stdout / stderr ---------------------------------------------------------------------


def patch_print() -> None:
    """Redact `print()`.

    Wrapping the builtin rather than only the stream matters because `print` looks up
    `sys.stdout` on every call, so this keeps working when a library (or a notebook kernel)
    swaps the stream out after redaction was installed.
    """
    global _print_patch
    if _print_patch is not None:
        return
    original = builtins.print

    def patched_print(*args: Any, **kwargs: Any) -> Any:
        # print stringifies each argument anyway, so doing it here first loses nothing and
        # lets a secret inside a dict or a dataclass be caught too
        return original(
            *(redact(arg if isinstance(arg, str) else str(arg)) for arg in args), **kwargs
        )

    patched_print._varlock_patched = True  # type: ignore[attr-defined]
    builtins.print = patched_print
    _print_patch = (original, patched_print)


def unpatch_print() -> None:
    global _print_patch
    if _print_patch is None:
        return
    original, patched_print = _print_patch
    if builtins.print is patched_print:
        builtins.print = original
    _print_patch = None


def patch_streams() -> None:
    """Redact direct writes to `sys.stdout` / `sys.stderr`.

    Calling this again after a stream has been replaced re-patches the new one, so
    `install_redaction()` is the fix when something swapped a stream out from under us.
    """
    for name in ("stdout", "stderr"):
        stream = getattr(sys, name, None)
        if stream is None:
            continue
        patched = _patched_streams.get(name)
        if patched is not None:
            if patched[0] is stream:
                continue
            # the stream was replaced after we patched it; drop the stale record
            _unpatch_stream(name)

        original = getattr(stream, "write", None)
        if original is None or getattr(original, "_varlock_patched", False):
            continue

        def make_write(orig: Any) -> Any:
            def write(text: Any) -> Any:
                return orig(redact(text) if isinstance(text, str) else text)

            write._varlock_patched = True  # type: ignore[attr-defined]
            return write

        had_own_write = "write" in getattr(stream, "__dict__", {})
        try:
            stream.write = make_write(original)
        except (AttributeError, TypeError):
            # a stream that doesn't allow attribute assignment (some C-level objects)
            continue
        _patched_streams[name] = (stream, original, stream.write, had_own_write)


def _unpatch_stream(name: str) -> None:
    patched = _patched_streams.pop(name, None)
    if patched is None:
        return
    stream, original, patched_write, had_own_write = patched
    try:
        if stream.write is patched_write:
            if had_own_write:
                stream.write = original
            else:
                del stream.write
    except (AttributeError, TypeError):
        pass


def unpatch_streams() -> None:
    for name in list(_patched_streams):
        _unpatch_stream(name)


# -- notebook cell output ----------------------------------------------------------------


def _get_ipython() -> Optional[Any]:
    try:
        from IPython import get_ipython
    except Exception:
        return None
    try:
        return get_ipython()
    except Exception:
        return None


def patch_ipython() -> None:
    """Redact notebook cell output.

    A cell's result is sent straight to the frontend through the display formatter rather
    than through stdout, so this is the only thing that catches an echoed secret.
    """
    global _patched_formatter
    if _patched_formatter is not None:
        return
    ipython = _get_ipython()
    formatter = getattr(ipython, "display_formatter", None)
    if formatter is None:
        return
    original = formatter.format
    if getattr(original, "_varlock_patched", False):
        return

    def patched_format(obj: Any, *args: Any, **kwargs: Any):
        data, metadata = original(obj, *args, **kwargs)
        redacted = {
            key: (redact(value) if isinstance(value, str) else value)
            for key, value in data.items()
        }
        return redacted, metadata

    patched_format._varlock_patched = True  # type: ignore[attr-defined]
    formatter.format = patched_format
    _patched_formatter = (formatter, original, patched_format)


def unpatch_ipython() -> None:
    global _patched_formatter
    if _patched_formatter is None:
        return
    formatter, original, patched_format = _patched_formatter
    try:
        if formatter.format is patched_format:
            formatter.format = original
    except (AttributeError, TypeError):
        pass
    _patched_formatter = None


# -- all ---------------------------------------------------------------------------------


def patch_all() -> None:
    patch_logging()
    patch_print()
    patch_streams()
    patch_ipython()


def unpatch_all() -> None:
    unpatch_logging()
    unpatch_print()
    unpatch_streams()
    unpatch_ipython()


def is_patched() -> bool:
    return _logging_patch is not None or _print_patch is not None
