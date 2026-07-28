"""Parsing the serialized env graph (the `__VARLOCK_ENV` blob)."""

from __future__ import annotations

import json
import math
from typing import Any, Dict, FrozenSet, List, Optional

from .errors import VarlockLoadError

#: Marks an encrypted blob. See `@encryptInjectedEnv`.
ENCRYPTED_BLOB_PREFIX = "varlock:v1:"

#: Set by `varlock run` in the child process.
BLOB_ENV_VAR = "__VARLOCK_ENV"
RUN_FLAG_ENV_VAR = "__VARLOCK_RUN"

_ENCRYPTED_MSG = (
    "__VARLOCK_ENV is encrypted and this package cannot decrypt it. "
    "Disable @encryptInjectedEnv for processes that load env from Python."
)


def js_env_string(value: Any, env_str: Optional[str] = None) -> str:
    """Serialize a resolved value the way varlock injects it into the environment.

    Composite values (arrays/objects) carry their flat form in the blob as ``envStr``, since
    re-deriving it needs type settings that don't travel in the blob. Everything else is
    stringified the way the CLI does it, which is JS semantics: ``True`` becomes ``"true"``,
    not ``"True"``.
    """
    if env_str is not None:
        return env_str
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if math.isnan(value):
            return "NaN"
        if math.isinf(value):
            return "Infinity" if value > 0 else "-Infinity"
        # JS prints whole floats without a trailing `.0`
        if value.is_integer() and abs(value) < 1e21:
            return str(int(value))
        return repr(value)
    if value is None:
        return ""
    return json.dumps(value)


class LoadedGraph:
    """The parts of a serialized env graph this package uses."""

    __slots__ = (
        "values",
        "env_strings",
        "declared_keys",
        "sensitive_keys",
        "settings",
        "errors",
        "raw",
    )

    def __init__(
        self,
        *,
        values: Dict[str, Any],
        env_strings: Dict[str, str],
        declared_keys: List[str],
        sensitive_keys: FrozenSet[str],
        settings: Dict[str, Any],
        errors: Optional[Dict[str, Any]],
        raw: Dict[str, Any],
    ) -> None:
        self.values = values
        self.env_strings = env_strings
        self.declared_keys = declared_keys
        self.sensitive_keys = sensitive_keys
        self.settings = settings
        self.errors = errors
        self.raw = raw


def parse_graph(data: Dict[str, Any]) -> LoadedGraph:
    """Normalize an already-decoded serialized graph."""
    config = data.get("config") or {}
    values: Dict[str, Any] = {}
    env_strings: Dict[str, str] = {}
    declared_keys: List[str] = []
    sensitive: List[str] = []

    for key, entry in config.items():
        declared_keys.append(key)
        if entry.get("isSensitive"):
            sensitive.append(key)
        # unset optional items are serialized without a `value` at all, so a missing key here
        # means "declared but has no value", which is distinct from a value of None
        if "value" not in entry:
            continue
        value = entry["value"]
        values[key] = value
        env_strings[key] = js_env_string(value, entry.get("envStr"))

    return LoadedGraph(
        values=values,
        env_strings=env_strings,
        declared_keys=declared_keys,
        sensitive_keys=frozenset(sensitive),
        settings=data.get("settings") or {},
        errors=data.get("errors"),
        raw=data,
    )


def parse_blob(blob: str) -> LoadedGraph:
    """Parse a raw `__VARLOCK_ENV` blob string."""
    if blob.startswith(ENCRYPTED_BLOB_PREFIX):
        raise VarlockLoadError(_ENCRYPTED_MSG)
    try:
        data = json.loads(blob)
    except ValueError as err:
        raise VarlockLoadError(f"Could not parse the __VARLOCK_ENV blob: {err}") from err
    if not isinstance(data, dict):
        raise VarlockLoadError("Expected the __VARLOCK_ENV blob to be a JSON object")
    return parse_graph(data)


def partial_values_from_stdout(stdout: str) -> Dict[str, Any]:
    """Best-effort extraction of values from a failed load.

    On a validation failure (as opposed to a schema/parse error) the CLI still writes the
    serialized graph to stdout, so items unrelated to the failure have real values here. Used
    to populate :attr:`VarlockLoadError.partial_values`.
    """
    if not stdout:
        return {}
    try:
        data = json.loads(stdout)
        config = data.get("config") or {}
        return {key: entry.get("value") for key, entry in config.items()}
    except Exception:
        return {}
