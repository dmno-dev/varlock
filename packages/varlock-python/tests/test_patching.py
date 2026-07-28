from __future__ import annotations

import builtins
import json
import logging

import pytest

import varlock
from varlock import _patch

from .conftest import SAMPLE_BLOB

SECRET = "super-secret-value"


def test_print_is_redacted(loaded, capsys):
    print(f"token={SECRET}")
    out = capsys.readouterr().out
    assert SECRET not in out
    assert "token=su▒▒▒▒▒" in out


def test_print_redacts_secrets_inside_objects(loaded, capsys):
    # print stringifies its arguments, so a secret nested in a dict has to be caught too
    print({"config": {"token": SECRET}})
    assert SECRET not in capsys.readouterr().out


def test_print_preserves_sep_and_end(loaded, capsys):
    print("a", "b", sep="-", end="!")
    assert capsys.readouterr().out == "a-b!"


def test_stderr_is_redacted(loaded, capsys):
    import sys

    print(SECRET, file=sys.stderr)
    assert SECRET not in capsys.readouterr().err


def test_logging_is_redacted(loaded, caplog):
    with caplog.at_level(logging.INFO):
        logging.getLogger("some.library").info("using %s", SECRET)
    assert SECRET not in caplog.text
    assert "su▒▒▒▒▒" in caplog.text


def test_logging_redaction_covers_loggers_created_after_loading(loaded, caplog):
    # the record factory applies everywhere, unlike a filter on one logger or handler
    with caplog.at_level(logging.INFO):
        logging.getLogger("created.later").info("value: %s", SECRET)
    assert SECRET not in caplog.text


def test_logging_redacts_dict_style_args(loaded, caplog):
    with caplog.at_level(logging.INFO):
        logging.getLogger("pct").info("%(token)s", {"token": SECRET})
    assert SECRET not in caplog.text


def test_uninstall_stops_patching(loaded, capsys):
    varlock.uninstall_redaction()
    print(SECRET)
    assert SECRET in capsys.readouterr().out


def test_uninstall_restores_everything_it_patched(loaded):
    import builtins
    import io

    stream = io.StringIO()
    monkey = pytest.MonkeyPatch()
    monkey.setattr("sys.stdout", stream)
    varlock.install_redaction()
    assert getattr(stream.write, "_varlock_patched", False)

    varlock.uninstall_redaction()
    assert not getattr(stream.write, "_varlock_patched", False)
    assert not getattr(builtins.print, "_varlock_patched", False)
    assert not getattr(logging.getLogRecordFactory(), "_varlock_patched", False)
    monkey.undo()


def test_direct_stream_writes_are_redacted(loaded):
    import io

    stream = io.StringIO()
    monkey = pytest.MonkeyPatch()
    monkey.setattr("sys.stdout", stream)
    varlock.install_redaction()
    # bypasses print() entirely
    stream.write(f"raw {SECRET}")
    varlock.uninstall_redaction()
    monkey.undo()
    assert SECRET not in stream.getvalue()


def test_a_stream_replaced_after_install_is_repatched(loaded):
    import io

    replacement = io.StringIO()
    monkey = pytest.MonkeyPatch()
    monkey.setattr("sys.stdout", replacement)
    # the notebook case: something swapped the stream out after we patched the old one
    varlock.install_redaction()
    replacement.write(SECRET)
    varlock.uninstall_redaction()
    monkey.undo()
    assert SECRET not in replacement.getvalue()


def test_redact_logs_false_skips_patching(fake_cli, capsys):
    fake_cli()
    varlock.load(redact_logs=False)
    print(SECRET)
    assert SECRET in capsys.readouterr().out


def test_schema_setting_disables_patching(fake_cli, capsys):
    graph = json.loads(SAMPLE_BLOB)
    graph["settings"]["redactLogs"] = False
    fake_cli(stdout=json.dumps(graph))
    varlock.load()
    print(SECRET)
    assert SECRET in capsys.readouterr().out


def test_reload_with_redaction_disabled_removes_patches(fake_cli):
    fake_cli()
    varlock.load()
    assert _patch.is_patched()

    varlock.reload(redact_logs=False)
    assert not _patch.is_patched()


def test_reload_follows_schema_when_redaction_is_disabled(fake_cli):
    fake_cli()
    varlock.load()
    assert _patch.is_patched()

    graph = json.loads(SAMPLE_BLOB)
    graph["settings"]["redactLogs"] = False
    fake_cli(stdout=json.dumps(graph))
    varlock.reload()
    assert not _patch.is_patched()


def test_patching_is_idempotent(loaded, capsys):
    varlock.install_redaction()
    varlock.install_redaction()
    print(SECRET)
    out = capsys.readouterr().out
    # masked once, not masked repeatedly by stacked patches
    assert out.strip() == "su▒▒▒▒▒"
    varlock.uninstall_redaction()
    print(SECRET)
    assert SECRET in capsys.readouterr().out


def test_a_foreign_log_factory_installed_later_is_not_clobbered(loaded, caplog):
    varlock.install_redaction()
    ours = logging.getLogRecordFactory()
    original = _patch._logging_patch[0]

    def theirs(*args, **kwargs):
        return ours(*args, **kwargs)

    logging.setLogRecordFactory(theirs)
    try:
        varlock.uninstall_redaction()
        assert logging.getLogRecordFactory() is theirs
        with caplog.at_level(logging.INFO):
            logging.getLogger("foreign.factory").info("still works")
        assert "still works" in caplog.text
    finally:
        logging.setLogRecordFactory(original)


def test_a_foreign_print_wrapper_installed_later_is_not_clobbered(loaded, capsys):
    ours = builtins.print
    original = _patch._print_patch[0]

    def theirs(*args, **kwargs):
        return ours(*args, **kwargs)

    builtins.print = theirs
    try:
        varlock.uninstall_redaction()
        assert builtins.print is theirs
        print("still works")
        assert "still works" in capsys.readouterr().out
    finally:
        builtins.print = original


def test_a_foreign_stream_wrapper_installed_later_is_not_clobbered(loaded, monkeypatch):
    import io

    stream = io.StringIO()
    monkeypatch.setattr("sys.stdout", stream)
    varlock.install_redaction()
    ours = stream.write

    def theirs(text):
        return ours(text)

    stream.write = theirs
    varlock.uninstall_redaction()
    assert stream.write is theirs
    stream.write("still works")
    assert "still works" in stream.getvalue()


# -- notebook output ---------------------------------------------------------------------


class _FakeFormatter:
    def format(self, obj, *args, **kwargs):
        return {"text/plain": repr(obj)}, {}


class _FakeIPython:
    def __init__(self):
        self.display_formatter = _FakeFormatter()


def test_ipython_display_output_is_redacted(loaded, monkeypatch):
    fake = _FakeIPython()
    monkeypatch.setattr(_patch, "_get_ipython", lambda: fake)
    varlock.install_redaction()

    # a cell result goes to the frontend through the formatter, never through stdout
    data, _ = fake.display_formatter.format({"token": SECRET})
    assert SECRET not in data["text/plain"]

    varlock.uninstall_redaction()
    data, _ = fake.display_formatter.format({"token": SECRET})
    assert SECRET in data["text/plain"]


def test_a_foreign_formatter_wrapper_installed_later_is_not_clobbered(loaded, monkeypatch):
    fake = _FakeIPython()
    monkeypatch.setattr(_patch, "_get_ipython", lambda: fake)
    varlock.install_redaction()
    ours = fake.display_formatter.format

    def theirs(*args, **kwargs):
        return ours(*args, **kwargs)

    fake.display_formatter.format = theirs
    varlock.uninstall_redaction()
    assert fake.display_formatter.format is theirs
    data, _ = fake.display_formatter.format("still works")
    assert "still works" in data["text/plain"]


def test_ipython_patch_is_a_noop_outside_a_notebook(loaded, monkeypatch):
    monkeypatch.setattr(_patch, "_get_ipython", lambda: None)
    varlock.install_redaction()  # must not raise


def test_env_repr_is_redacted_in_a_notebook(loaded, monkeypatch):
    fake = _FakeIPython()
    monkeypatch.setattr(_patch, "_get_ipython", lambda: fake)
    varlock.install_redaction()
    data, _ = fake.display_formatter.format(varlock.ENV)
    assert SECRET not in data["text/plain"]
