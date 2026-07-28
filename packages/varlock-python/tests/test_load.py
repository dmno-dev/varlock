from __future__ import annotations

import json
import os

import pytest

import varlock
from varlock import VarlockLoadError

from .conftest import SAMPLE_BLOB


def test_load_reads_an_already_injected_blob_without_running_the_cli(monkeypatch):
    monkeypatch.setenv("__VARLOCK_ENV", SAMPLE_BLOB)
    monkeypatch.setattr(
        varlock, "run_load", lambda **kwargs: pytest.fail("should not run the CLI")
    )
    env = varlock.load()
    assert env["PORT"] == 8080


def test_load_is_idempotent(fake_cli, recorded_argv):
    argv_path = fake_cli()
    varlock.load()
    argv_path.unlink()
    varlock.load()
    assert not argv_path.exists(), "second load should not have run the CLI again"


def test_load_runs_the_cli_with_expected_flags(fake_cli, recorded_argv):
    argv_path = fake_cli()
    varlock.load()
    assert recorded_argv(argv_path) == ["load", "--format", "json-full", "--compact"]


def test_load_passes_path_and_env_flags(fake_cli, recorded_argv):
    argv_path = fake_cli()
    varlock.load(path=[".env.prod", "./envs"], env="production")
    argv = recorded_argv(argv_path)
    assert argv[-6:] == ["--path", ".env.prod", "--path", "./envs", "--env", "production"]


def test_load_injects_values_into_os_environ(fake_cli):
    fake_cli()
    varlock.load()
    assert os.environ["APP_ENV"] == "development"
    # serialized the way the CLI does it, not the way Python's str() would
    assert os.environ["PORT"] == "8080"
    assert os.environ["DEBUG"] == "true"
    # composite values use the flat form carried in the blob
    assert os.environ["TAGS"] == "a,b"
    # unset optional items are not injected at all, matching `varlock run`
    assert "OPTIONAL_UNSET" not in os.environ


def test_load_publishes_the_blob_for_subprocesses(fake_cli):
    fake_cli()
    varlock.load()
    assert json.loads(os.environ["__VARLOCK_ENV"])["config"]["PORT"]["value"] == 8080


def test_inject_false_touches_nothing(fake_cli):
    fake_cli()
    varlock.load(inject=False)
    assert "APP_ENV" not in os.environ
    assert "__VARLOCK_ENV" not in os.environ


def test_disable_process_env_injection_setting_is_honored(fake_cli):
    graph = json.loads(SAMPLE_BLOB)
    graph["settings"]["disableProcessEnvInjection"] = True
    fake_cli(stdout=json.dumps(graph))
    env = varlock.load()
    assert env["PORT"] == 8080
    assert "APP_ENV" not in os.environ


def test_unload_restores_the_environment(fake_cli):
    fake_cli()
    before = dict(os.environ)
    varlock.load()
    varlock.unload()
    assert dict(os.environ) == before
    assert not varlock.is_loaded()


def test_unload_restores_a_preexisting_value(fake_cli, monkeypatch):
    monkeypatch.setenv("APP_ENV", "set-by-the-user")
    fake_cli()
    varlock.load()
    assert os.environ["APP_ENV"] == "development"
    varlock.unload()
    assert os.environ["APP_ENV"] == "set-by-the-user"


def test_reload_reruns_the_cli(fake_cli, recorded_argv):
    argv_path = fake_cli()
    varlock.load()
    argv_path.unlink()
    varlock.reload()
    assert argv_path.exists()


def test_reload_picks_up_new_values(fake_cli, tmp_path, monkeypatch):
    fake_cli()
    assert varlock.load()["PORT"] == 8080

    graph = json.loads(SAMPLE_BLOB)
    graph["config"]["PORT"]["value"] = 9999
    fake_cli(stdout=json.dumps(graph))
    assert varlock.reload()["PORT"] == 9999
    assert os.environ["PORT"] == "9999"


def test_reload_drops_keys_that_left_the_schema(fake_cli):
    fake_cli()
    varlock.load()
    assert "TAGS" in os.environ

    graph = json.loads(SAMPLE_BLOB)
    del graph["config"]["TAGS"]
    fake_cli(stdout=json.dumps(graph))
    env = varlock.reload()
    assert "TAGS" not in env
    assert "TAGS" not in os.environ


def test_failed_load_raises_with_cli_output(fake_cli):
    partial = json.dumps({"config": {"APP_ENV": {"value": "development"}}})
    fake_cli(stdout=partial, stderr="💥 SOME_KEY is required", exit_code=1)
    with pytest.raises(VarlockLoadError) as err:
        varlock.load()
    assert err.value.exit_code == 1
    assert "SOME_KEY is required" in str(err.value)
    assert err.value.partial_values == {"APP_ENV": "development"}
    assert not varlock.is_loaded()


def test_on_error_exit_writes_stderr_and_exits(fake_cli, capsys):
    fake_cli(stdout="", stderr="💥 SOME_KEY is required", exit_code=3)
    with pytest.raises(SystemExit) as err:
        varlock.load(on_error="exit")
    assert err.value.code == 3
    assert "SOME_KEY is required" in capsys.readouterr().err


def test_encrypted_blob_reports_clearly(monkeypatch):
    monkeypatch.setenv("__VARLOCK_ENV", "varlock:v1:abc123")
    with pytest.raises(VarlockLoadError) as err:
        varlock.load()
    assert "encrypted" in str(err.value)


def test_is_running_under_varlock_run(monkeypatch):
    assert not varlock.is_running_under_varlock_run()
    monkeypatch.setenv("__VARLOCK_RUN", "1")
    assert varlock.is_running_under_varlock_run()
