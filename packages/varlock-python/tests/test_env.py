from __future__ import annotations

import pytest

import varlock
from varlock import VarlockMissingKeyError, VarlockNotLoadedError


def test_values_are_coerced_not_strings(loaded):
    assert loaded["APP_ENV"] == "development"
    assert loaded["PORT"] == 8080
    assert loaded["DEBUG"] is True
    assert loaded["TAGS"] == ["a", "b"]


def test_attribute_access_matches_item_access(loaded):
    assert loaded.PORT == loaded["PORT"]


def test_mapping_protocol(loaded):
    assert "APP_ENV" in loaded
    assert loaded.get("NOPE") is None
    assert loaded.get("NOPE", "fallback") == "fallback"
    assert set(loaded.keys()) == {"APP_ENV", "PORT", "DEBUG", "SECRET", "TAGS"}
    assert dict(loaded)["PORT"] == 8080
    assert len(loaded) == 5


def test_unknown_key_raises(loaded):
    with pytest.raises(VarlockMissingKeyError) as err:
        loaded["NOPE"]
    assert "does not exist" in str(err.value)


def test_unknown_key_is_catchable_as_key_and_attribute_error(loaded):
    with pytest.raises(KeyError):
        loaded["NOPE"]
    with pytest.raises(AttributeError):
        loaded.NOPE


def test_declared_but_unset_key_says_so(loaded):
    with pytest.raises(VarlockMissingKeyError) as err:
        loaded["OPTIONAL_UNSET"]
    assert "no value in this environment" in str(err.value)
    # still absent from the mapping, matching the generated module's NotRequired contract
    assert "OPTIONAL_UNSET" not in loaded
    assert loaded.get("OPTIONAL_UNSET") is None


def test_access_before_load_raises_actionable_error():
    with pytest.raises(VarlockNotLoadedError) as err:
        varlock.ENV.APP_ENV
    assert "varlock.load()" in str(err.value)


def test_dunder_probes_do_not_raise_varlock_errors():
    # IPython and copy/pickle probe for private attributes before anything is loaded
    assert not hasattr(varlock.ENV, "_ipython_canary_method_should_not_exist_")
    assert not hasattr(varlock.ENV, "__wrapped__")


def test_uninitialized_instance_does_not_recurse(loaded):
    # copy/pickle can build an instance without running __init__
    bare = varlock.Env.__new__(varlock.Env)
    with pytest.raises(AttributeError):
        bare._state


def test_repr_redacts_sensitive_values(loaded):
    text = repr(loaded)
    assert "super-secret-value" not in text
    assert "su▒▒▒▒▒" in text
    assert "development" in text


def test_html_repr_redacts_sensitive_values(loaded):
    html = loaded._repr_html_()
    assert "super-secret-value" not in html
    assert "OPTIONAL_UNSET" not in html
    assert "1 declared key(s)" in html


def test_to_dict(loaded):
    assert loaded.to_dict()["SECRET"] == "super-secret-value"
    assert loaded.to_dict(redact_sensitive=True)["SECRET"] == "su▒▒▒▒▒"


def test_dir_includes_keys_for_tab_completion(loaded):
    assert "APP_ENV" in dir(loaded)


def test_sensitive_keys(loaded):
    assert varlock.get_sensitive_keys() == frozenset({"SECRET"})
