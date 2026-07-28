from __future__ import annotations

import json

import pytest

import varlock

from .conftest import SAMPLE_BLOB

COMPOSITE_BLOB = json.dumps(
    {
        "settings": {},
        "config": {
            "APP_ENV": {"value": "development", "isSensitive": False},
            "SECRET": {"value": "super-secret-value", "isSensitive": True},
            "KEYS": {
                "value": ["first-secret", "second-secret"],
                "envStr": "first-secret,second-secret",
                "isSensitive": True,
            },
            "CREDS": {
                "value": {"user": "admin", "password": "hunter2000"},
                "envStr": '{"user":"admin","password":"hunter2000"}',
                "isSensitive": True,
            },
            "PUBLIC_TOKEN": {"value": "not-a-secret", "isSensitive": False},
        },
    }
)


@pytest.fixture
def composite(monkeypatch):
    monkeypatch.setenv("__VARLOCK_ENV", COMPOSITE_BLOB)
    return varlock.load()


def test_redacts_a_sensitive_value_inside_a_larger_string(loaded):
    text = "connecting with super-secret-value now"
    assert varlock.redact(text) == "connecting with su▒▒▒▒▒ now"


def test_leaves_non_sensitive_values_alone(composite):
    assert varlock.redact("not-a-secret is fine") == "not-a-secret is fine"


def test_redacts_through_containers(loaded):
    payload = {
        "token": "super-secret-value",
        "nested": [{"deep": "super-secret-value"}],
        "tuple": ("super-secret-value",),
    }
    result = varlock.redact(payload)
    assert result["token"] == "su▒▒▒▒▒"
    assert result["nested"][0]["deep"] == "su▒▒▒▒▒"
    assert result["tuple"] == ("su▒▒▒▒▒",)
    # the original is not mutated
    assert payload["token"] == "super-secret-value"


def test_redacts_individual_elements_of_a_composite_value(composite):
    # leaking one element of an array must be caught, not only the whole serialized value
    assert varlock.redact("first-secret") == "fi▒▒▒▒▒"
    assert varlock.redact("hunter2000") == "hu▒▒▒▒▒"


def test_redacts_the_flat_env_string_form(composite):
    assert "first-secret" not in varlock.redact("first-secret,second-secret")


def test_overlapping_values_match_maximally(monkeypatch):
    blob = json.dumps(
        {
            "settings": {},
            "config": {
                "SHORT": {"value": "abc", "isSensitive": True},
                "LONG": {"value": "abcdef", "isSensitive": True},
            },
        }
    )
    monkeypatch.setenv("__VARLOCK_ENV", blob)
    varlock.load()
    # the longer value wins, rather than being masked as the shorter one plus leftovers
    assert varlock.redact("abcdef") == "ab▒▒▒▒▒"


def test_non_string_values_are_left_alone(loaded):
    # PORT is 8080; masking every occurrence of "8080" everywhere would be worse than useless
    assert varlock.redact("listening on 8080") == "listening on 8080"


def test_redact_is_a_noop_before_loading():
    assert varlock.redact("super-secret-value") == "super-secret-value"


def test_reveal_keeps_a_deliberately_shown_value_visible(loaded):
    revealed = varlock.reveal("super-secret-value")
    assert "super-secret-value" in varlock.redact(revealed)


def test_reveal_passes_through_when_redaction_is_inactive():
    assert varlock.reveal("anything") == "anything"


def test_reload_rebuilds_the_map(fake_cli):
    fake_cli()
    varlock.load()
    assert varlock.redact("super-secret-value") == "su▒▒▒▒▒"

    graph = json.loads(SAMPLE_BLOB)
    graph["config"]["SECRET"]["value"] = "a-brand-new-secret"
    fake_cli(stdout=json.dumps(graph))
    varlock.reload()

    # the old value is no longer current, so it is no longer masked
    assert varlock.redact("super-secret-value") == "super-secret-value"
    assert varlock.redact("a-brand-new-secret") == "a-▒▒▒▒▒"


def test_unload_stops_redacting(loaded):
    varlock.unload()
    assert varlock.redact("super-secret-value") == "super-secret-value"
