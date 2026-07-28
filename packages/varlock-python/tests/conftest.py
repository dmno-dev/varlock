from __future__ import annotations

import json
import os
import stat
import sys

import pytest

import varlock
from varlock import _binary

SAMPLE_GRAPH = {
    "settings": {},
    "config": {
        "APP_ENV": {"value": "development", "isSensitive": False},
        "PORT": {"value": 8080, "isSensitive": False},
        "DEBUG": {"value": True, "isSensitive": False},
        "SECRET": {"value": "super-secret-value", "isSensitive": True},
        "TAGS": {"value": ["a", "b"], "envStr": "a,b", "isSensitive": False},
        # declared with no value - an unset optional item
        "OPTIONAL_UNSET": {"isSensitive": False},
    },
}

SAMPLE_BLOB = json.dumps(SAMPLE_GRAPH)


@pytest.fixture(autouse=True)
def clean_state(monkeypatch):
    """Each test starts with nothing loaded and no varlock env vars set."""
    varlock.unload()
    for key in ("__VARLOCK_ENV", "__VARLOCK_RUN", _binary.BIN_PATH_ENV_VAR):
        monkeypatch.delenv(key, raising=False)
    _binary.clear_cache()
    yield
    varlock.unload()
    _binary.clear_cache()


@pytest.fixture
def fake_cli(tmp_path, monkeypatch):
    """Install a fake `varlock` binary and point VARLOCK_BIN at it.

    The fake records the argv it was called with (in `argv.json` next to it) so tests can
    assert on the flags the package passes.
    """

    def _install(*, stdout: str = SAMPLE_BLOB, stderr: str = "", exit_code: int = 0):
        if sys.platform.startswith("win"):
            pytest.skip("fake CLI fixture uses a POSIX shebang script")
        argv_path = tmp_path / "argv.json"
        script = tmp_path / "varlock"
        script.write_text(
            "#!/usr/bin/env python3\n"
            "import json, sys\n"
            f"json.dump(sys.argv[1:], open({str(argv_path)!r}, 'w'))\n"
            f"sys.stdout.write({stdout!r})\n"
            f"sys.stderr.write({stderr!r})\n"
            f"sys.exit({exit_code})\n"
        )
        script.chmod(script.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
        monkeypatch.setenv(_binary.BIN_PATH_ENV_VAR, str(script))
        return argv_path

    return _install


@pytest.fixture
def recorded_argv():
    def _read(argv_path) -> list:
        return json.loads(argv_path.read_text())

    return _read


@pytest.fixture
def loaded(monkeypatch):
    """Env loaded from an already-injected blob, as if started by `varlock run`."""
    monkeypatch.setenv("__VARLOCK_ENV", SAMPLE_BLOB)
    return varlock.load()


@pytest.fixture
def env_snapshot():
    """Capture os.environ so a test can assert it was fully restored."""
    return dict(os.environ)
