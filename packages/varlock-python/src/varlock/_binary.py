"""Locating the varlock CLI binary.

Mirrors the search the JS integration does in `exec-sync-varlock.ts`, with the standalone
installer's locations added, since Python projects usually have no `node_modules` at all.
"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path
from typing import List, Optional

from .errors import VarlockBinaryNotFoundError

#: Set this to an absolute path to skip discovery entirely.
BIN_PATH_ENV_VAR = "VARLOCK_BIN"

_IS_WINDOWS = sys.platform.startswith("win")

# On Windows npm creates varlock.exe while pnpm only creates varlock.cmd (plus a shell script)
_BIN_NAMES = ("varlock.exe", "varlock.cmd") if _IS_WINDOWS else ("varlock",)

_INSTALL_HINT = (
    "Install it with one of:\n"
    "  brew install dmno-dev/tap/varlock\n"
    "  curl -sSfL https://varlock.dev/install.sh | sh -s\n"
    "or point VARLOCK_BIN at an existing binary.\n"
    "See https://varlock.dev/getting-started/installation/"
)

# discovery hits the filesystem, so cache per starting directory
_cache: dict = {}


def _is_executable(path: Path) -> bool:
    # .cmd/.bat shims are not marked executable on Windows, so only check existence there
    if _IS_WINDOWS:
        return path.is_file()
    return path.is_file() and os.access(path, os.X_OK)


def _standalone_install_dirs() -> List[Path]:
    """Directories the standalone installer (install.sh / homebrew) writes to."""
    dirs = []
    xdg = os.environ.get("XDG_CONFIG_HOME")
    if xdg:
        dirs.append(Path(xdg) / "varlock" / "bin")
    home = Path.home()
    dirs.append(home / ".varlock" / "bin")
    dirs.append(home / ".config" / "varlock" / "bin")
    return dirs


def _node_modules_dirs(start: Path) -> List[Path]:
    """Walk up from `start` collecting every `node_modules/.bin` along the way.

    Covers the case where a Python service lives inside a JS monorepo that installs varlock as
    a package.json dependency. A `.bin` directory that exists without varlock in it is not the
    end of the search: in a monorepo the root may have one while varlock is installed only in a
    sub-package (and vice versa).
    """
    dirs = []
    current = start
    while True:
        candidate = current / "node_modules" / ".bin"
        if candidate.is_dir():
            dirs.append(candidate)
        parent = current.parent
        if parent == current:
            break
        current = parent
    return dirs


def _candidate_dirs(start: Path) -> List[Path]:
    return _standalone_install_dirs() + _node_modules_dirs(start)


def find_binary(cwd: Optional[os.PathLike] = None, *, use_cache: bool = True) -> str:
    """Return the path to the varlock CLI binary.

    Search order: ``VARLOCK_BIN``, then ``PATH``, then the standalone install directories,
    then any ``node_modules/.bin`` walking up from ``cwd``.

    Raises:
        VarlockBinaryNotFoundError: if no binary is found.
    """
    explicit = os.environ.get(BIN_PATH_ENV_VAR)
    if explicit:
        path = Path(explicit).expanduser()
        if not _is_executable(path):
            raise VarlockBinaryNotFoundError(
                f"{BIN_PATH_ENV_VAR} is set to `{explicit}`, which is not an executable file",
                [str(path)],
            )
        return str(path)

    start = Path(cwd).resolve() if cwd else Path.cwd()
    cache_key = str(start)
    if use_cache and cache_key in _cache:
        return _cache[cache_key]

    searched: List[str] = []

    on_path = shutil.which("varlock")
    if on_path:
        if use_cache:
            _cache[cache_key] = on_path
        return on_path
    searched.append("PATH")

    for directory in _candidate_dirs(start):
        for name in _BIN_NAMES:
            candidate = directory / name
            searched.append(str(candidate))
            if _is_executable(candidate):
                resolved = str(candidate)
                if use_cache:
                    _cache[cache_key] = resolved
                return resolved

    raise VarlockBinaryNotFoundError(
        f"Unable to find the varlock CLI.\n{_INSTALL_HINT}",
        searched,
    )


def clear_cache() -> None:
    """Forget cached binary lookups (useful after installing varlock mid-session)."""
    _cache.clear()
