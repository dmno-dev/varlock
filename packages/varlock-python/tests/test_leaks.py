from __future__ import annotations

import json

import pytest

import varlock
from varlock import VarlockLeakError

SECRET = "super-secret-value"


def test_clean_content_passes_through_unchanged(loaded):
    payload = '{"ok": true}'
    assert varlock.scan_for_leaks(payload) is payload


def test_a_leaked_value_raises_and_names_the_key(loaded):
    with pytest.raises(VarlockLeakError) as err:
        varlock.scan_for_leaks(f'{{"token": "{SECRET}"}}')
    assert err.value.key == "SECRET"
    assert "SECRET" in str(err.value)


def test_scan_reports_where_it_was_scanning(loaded):
    with pytest.raises(VarlockLeakError) as err:
        varlock.scan_for_leaks(SECRET, method="response body", file="api/handler.py")
    assert "response body" in str(err.value)
    assert "api/handler.py" in str(err.value)


def test_scans_bytes(loaded):
    with pytest.raises(VarlockLeakError):
        varlock.scan_for_leaks(SECRET.encode())


def test_scans_elements_of_a_composite_value(monkeypatch):
    blob = json.dumps(
        {
            "settings": {},
            "config": {
                "KEYS": {
                    "value": ["first-secret", "second-secret"],
                    "envStr": "first-secret,second-secret",
                    "isSensitive": True,
                }
            },
        }
    )
    monkeypatch.setenv("__VARLOCK_ENV", blob)
    varlock.load()
    # leaking one element counts, not just the whole serialized value
    with pytest.raises(VarlockLeakError):
        varlock.scan_for_leaks("here is second-secret")


def test_items_opted_out_of_leak_detection_are_skipped(monkeypatch):
    blob = json.dumps(
        {
            "settings": {},
            "config": {
                # `@sensitive={preventLeaks=false}` - an endpoint legitimately returns this
                "RETURNED_TOKEN": {
                    "value": "handed-out-on-purpose",
                    "isSensitive": True,
                    "preventLeaks": False,
                },
                "SECRET": {"value": SECRET, "isSensitive": True},
            },
        }
    )
    monkeypatch.setenv("__VARLOCK_ENV", blob)
    varlock.load()

    assert varlock.scan_for_leaks("handed-out-on-purpose") == "handed-out-on-purpose"
    # opting out of scanning does not opt out of masking in logs
    assert varlock.redact("handed-out-on-purpose") == "ha▒▒▒▒▒"
    with pytest.raises(VarlockLeakError):
        varlock.scan_for_leaks(SECRET)


def test_scan_is_a_noop_before_loading():
    assert varlock.scan_for_leaks(SECRET) == SECRET


def test_non_text_values_pass_through(loaded):
    sentinel = object()
    assert varlock.scan_for_leaks(sentinel) is sentinel
    assert varlock.scan_for_leaks(None) is None
