from __future__ import annotations

import json
import os

import pytest

import varlock
from varlock import VarlockLoadError

from .conftest import SAMPLE_BLOB


def test_a_failed_reload_keeps_the_previous_values(fake_cli):
    fake_cli()
    varlock.load()

    fake_cli(stdout="", stderr="💥 broken schema", exit_code=1)
    with pytest.raises(VarlockLoadError):
        varlock.reload()

    # the working env survives a bad edit, which matters most in a notebook
    assert varlock.is_loaded()
    assert varlock.ENV["PORT"] == 8080
    assert os.environ["PORT"] == "8080"


def test_reload_hands_the_cli_the_uninjected_environment(fake_cli, tmp_path, monkeypatch):
    """The CLI must not see values we injected, or it would treat them as overrides."""
    monkeypatch.setenv("APP_ENV", "set-by-the-user")
    env_dump = tmp_path / "child-env.json"

    graph = json.loads(SAMPLE_BLOB)
    fake_cli(stdout=json.dumps(graph))
    varlock.load()
    assert os.environ["APP_ENV"] == "development"

    # a fake that records the environment it was handed
    script = tmp_path / "varlock"
    script.write_text(
        "#!/usr/bin/env python3\n"
        "import json, os, sys\n"
        f"json.dump(dict(os.environ), open({str(env_dump)!r}, 'w'))\n"
        f"sys.stdout.write({json.dumps(graph)!r})\n"
    )
    script.chmod(0o755)
    monkeypatch.setenv("VARLOCK_BIN", str(script))

    varlock.reload()
    child_env = json.loads(env_dump.read_text())
    assert child_env["APP_ENV"] == "set-by-the-user"
    assert "__VARLOCK_ENV" not in child_env
