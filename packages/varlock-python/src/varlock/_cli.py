"""Calling the varlock CLI.

The Python package resolves nothing itself. Like the JS integration's `auto-load`, it shells
out to `varlock load --format json-full`, then parses the graph the CLI prints. Every plugin,
cache, and resolver behavior therefore comes from the CLI you have installed.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from typing import Any, Dict, List, Optional, Sequence, Union

from ._binary import find_binary
from ._blob import partial_values_from_stdout
from .errors import VarlockLoadError

PathArg = Union[str, os.PathLike]

INTEGRATION_ENV_VAR = "__VARLOCK_INTEGRATION"


def build_load_args(
    *,
    path: Optional[Union[PathArg, Sequence[PathArg]]] = None,
    env: Optional[str] = None,
    extra_args: Optional[Sequence[str]] = None,
) -> List[str]:
    args = ["load", "--format", "json-full", "--compact"]
    if path is not None:
        paths = [path] if isinstance(path, (str, os.PathLike)) else list(path)
        for p in paths:
            args += ["--path", os.fspath(p)]
    if env is not None:
        args += ["--env", env]
    if extra_args:
        args += list(extra_args)
    return args


def _child_env(version: str, base_env: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    child = dict(os.environ if base_env is None else base_env)
    # tells the CLI which integration invoked it (telemetry only)
    child[INTEGRATION_ENV_VAR] = f"python@{version}"
    return child


def run_load(
    *,
    version: str,
    cwd: Optional[PathArg] = None,
    path: Optional[Union[PathArg, Sequence[PathArg]]] = None,
    env: Optional[str] = None,
    extra_args: Optional[Sequence[str]] = None,
    timeout: Optional[float] = None,
    base_env: Optional[Dict[str, str]] = None,
) -> str:
    """Run `varlock load` and return its stdout (the serialized graph as JSON).

    Raises:
        VarlockBinaryNotFoundError: if the CLI can't be found.
        VarlockLoadError: if the CLI exits non-zero, or can't be run at all.
    """
    binary = find_binary(cwd)
    args = build_load_args(path=path, env=env, extra_args=extra_args)

    # pnpm creates a .cmd shim on Windows, which only runs through the shell
    needs_shell = sys.platform.startswith("win") and binary.lower().endswith(".cmd")
    command: Any = (
        subprocess.list2cmdline([binary, *args]) if needs_shell else [binary, *args]
    )

    try:
        result = subprocess.run(
            command,
            shell=needs_shell,
            cwd=os.fspath(cwd) if cwd is not None else None,
            env=_child_env(version, base_env),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as err:
        raise VarlockLoadError(
            f"`varlock load` timed out after {timeout}s",
            stderr=_decode(err.stderr),
            stdout=_decode(err.stdout),
        ) from err
    except OSError as err:
        raise VarlockLoadError(f"Could not run the varlock CLI at `{binary}`: {err}") from err

    stdout = _decode(result.stdout)
    stderr = _decode(result.stderr)

    if result.returncode != 0:
        raise VarlockLoadError(
            f"`varlock load` failed (exit code {result.returncode})",
            stderr=stderr,
            stdout=stdout,
            exit_code=result.returncode,
            errors=_errors_from_stdout(stdout),
            partial_values=partial_values_from_stdout(stdout),
        )

    if not stdout.strip():
        raise VarlockLoadError(
            "`varlock load` produced no output", stderr=stderr, stdout=stdout
        )

    return stdout


def _decode(raw: Optional[bytes]) -> str:
    if not raw:
        return ""
    if isinstance(raw, str):
        return raw
    return raw.decode("utf-8", errors="replace")


def _errors_from_stdout(stdout: str) -> Optional[Dict[str, Any]]:
    try:
        return json.loads(stdout).get("errors")
    except Exception:
        return None
