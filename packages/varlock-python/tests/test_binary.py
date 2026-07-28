from __future__ import annotations

import stat
import sys

import pytest

from varlock import VarlockBinaryNotFoundError, find_binary
from varlock._binary import BIN_PATH_ENV_VAR

pytestmark = pytest.mark.skipif(
    sys.platform.startswith("win"), reason="POSIX executable-bit behavior"
)


def _make_executable(path):
    path.write_text("#!/bin/sh\nexit 0\n")
    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    return path


def test_explicit_path_wins(tmp_path, monkeypatch):
    binary = _make_executable(tmp_path / "my-varlock")
    monkeypatch.setenv(BIN_PATH_ENV_VAR, str(binary))
    assert find_binary() == str(binary)


def test_explicit_path_must_be_executable(tmp_path, monkeypatch):
    not_executable = tmp_path / "varlock"
    not_executable.write_text("")
    monkeypatch.setenv(BIN_PATH_ENV_VAR, str(not_executable))
    with pytest.raises(VarlockBinaryNotFoundError):
        find_binary()


def test_found_on_path(tmp_path, monkeypatch):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    binary = _make_executable(bin_dir / "varlock")
    monkeypatch.setenv("PATH", str(bin_dir))
    assert find_binary() == str(binary)


def test_found_in_standalone_install_dir(tmp_path, monkeypatch):
    install_dir = tmp_path / "xdg" / "varlock" / "bin"
    install_dir.mkdir(parents=True)
    binary = _make_executable(install_dir / "varlock")
    monkeypatch.setenv("PATH", str(tmp_path / "empty"))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg"))
    assert find_binary() == str(binary)


def test_found_by_walking_up_to_node_modules(tmp_path, monkeypatch):
    # a python service inside a JS monorepo that installs varlock as a dependency
    bin_dir = tmp_path / "node_modules" / ".bin"
    bin_dir.mkdir(parents=True)
    binary = _make_executable(bin_dir / "varlock")
    nested = tmp_path / "services" / "api"
    nested.mkdir(parents=True)
    # an intermediate .bin without varlock in it must not stop the search
    (nested / "node_modules" / ".bin").mkdir(parents=True)
    monkeypatch.setenv("PATH", str(tmp_path / "empty"))
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.delenv("XDG_CONFIG_HOME", raising=False)
    assert find_binary(nested) == str(binary)


def test_missing_binary_explains_how_to_install(tmp_path, monkeypatch):
    monkeypatch.setenv("PATH", str(tmp_path / "empty"))
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.delenv("XDG_CONFIG_HOME", raising=False)
    with pytest.raises(VarlockBinaryNotFoundError) as err:
        find_binary(tmp_path)
    assert "install.sh" in str(err.value)
    assert err.value.searched
