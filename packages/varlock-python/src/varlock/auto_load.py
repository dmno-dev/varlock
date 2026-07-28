"""Load env as an import side effect, failing fast.

The equivalent of ``import 'varlock/auto-load'`` in JS. Import this once, as early as
possible, from a script or server entrypoint::

    import varlock.auto_load  # noqa: F401

    from varlock import ENV

If loading fails, the CLI's error output is printed and the process exits non-zero, so nothing
downstream runs with an invalid env.

Prefer calling :func:`varlock.load` directly in notebooks and other long-lived sessions, where
exiting the process is the wrong response to a schema typo.
"""

from __future__ import annotations

from . import load

load(on_error="exit")
