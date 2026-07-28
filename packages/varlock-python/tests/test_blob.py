from __future__ import annotations

import pytest

from varlock._blob import js_env_string, parse_blob, partial_values_from_stdout
from varlock.errors import VarlockLoadError


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("plain", "plain"),
        (True, "true"),
        (False, "false"),
        (8080, "8080"),
        (1.5, "1.5"),
        # JS prints whole floats without a trailing `.0`
        (2.0, "2"),
        (None, ""),
    ],
)
def test_env_strings_match_cli_serialization(value, expected):
    assert js_env_string(value) == expected


def test_composite_values_use_the_flat_form_from_the_blob():
    assert js_env_string(["a", "b"], "a,b") == "a,b"


def test_parse_blob_rejects_an_encrypted_blob():
    with pytest.raises(VarlockLoadError) as err:
        parse_blob("varlock:v1:whatever")
    assert "encrypted" in str(err.value)


def test_parse_blob_rejects_garbage():
    with pytest.raises(VarlockLoadError):
        parse_blob("not json")
    with pytest.raises(VarlockLoadError):
        parse_blob("[1, 2, 3]")


def test_parse_blob_separates_declared_from_valued_keys():
    graph = parse_blob(
        '{"config": {"SET": {"value": 1, "isSensitive": false},'
        ' "UNSET": {"isSensitive": true}}}'
    )
    assert graph.values == {"SET": 1}
    assert graph.declared_keys == ["SET", "UNSET"]
    # sensitivity is tracked for every declared key, valued or not
    assert graph.sensitive_keys == frozenset({"UNSET"})


def test_partial_values_from_a_failed_load():
    stdout = '{"config": {"OK": {"value": "yes"}, "BROKEN": {}}}'
    assert partial_values_from_stdout(stdout) == {"OK": "yes", "BROKEN": None}


def test_partial_values_tolerates_unparseable_output():
    assert partial_values_from_stdout("💥 not json") == {}
    assert partial_values_from_stdout("") == {}
