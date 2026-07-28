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


def quote_for_cmd(arg: str) -> str:
    """Quote a single argument for a Windows command line, always adding the quotes.

    This is the MSVCRT quoting algorithm that `subprocess.list2cmdline` uses, except that it
    quotes unconditionally. `list2cmdline` only quotes an argument containing whitespace,
    which is not enough here: `cmd.exe` parses its own metacharacters (`&`, `|`, `<`, `>`,
    `^`, parens) out of *unquoted* text before argument splitting ever happens, so
    `--path a&b` would run `b` as a second command. Inside double quotes it treats them as
    ordinary characters.
    """
    result = ['"']
    backslashes = 0
    for char in arg:
        if char == "\\":
            backslashes += 1
            continue
        if char == '"':
            # a quote is escaped by a backslash, and every backslash before it doubles
            result.append("\\" * (backslashes * 2 + 1))
        else:
            result.append("\\" * backslashes)
        backslashes = 0
        result.append(char)
    # backslashes before the closing quote double, so they aren't read as escaping it
    result.append("\\" * (backslashes * 2))
    result.append('"')
    return "".join(result)


def build_cmd_shim_command(binary: str, args: Sequence[str], comspec: Optional[str] = None) -> str:
    """Build the command line for running a `.cmd` shim through `cmd.exe`.

    Uses the `cmd.exe /d /s /c "..."` form: `/s` makes cmd strip the outer quote pair and
    take the rest verbatim, and every token inside is quoted individually, so a
    metacharacter in a path or an argument stays literal. Handed to `subprocess` with
    `shell=False` so this exact string reaches `CreateProcess`, rather than `shell=True`
    building a `/c` line whose quote-stripping rules are far harder to reason about.
    """
    shell = comspec or os.environ.get("COMSPEC") or "cmd.exe"
    inner = " ".join(quote_for_cmd(token) for token in (binary, *args))
    return f'{quote_for_cmd(shell)} /d /s /c "{inner}"'


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

    # pnpm creates a .cmd shim on Windows, and a batch file can only be run by cmd.exe.
    # Everything else is executed directly, with no shell involved at all.
    is_cmd_shim = sys.platform.startswith("win") and binary.lower().endswith(".cmd")
    command: Any = (
        build_cmd_shim_command(binary, args) if is_cmd_shim else [binary, *args]
    )

    try:
        result = subprocess.run(
            command,
            shell=False,
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
