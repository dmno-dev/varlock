"""Smoke test for the native Python package (packages/varlock-python).

Runs both standalone (the package shells out to the CLI itself) and under `varlock run`
(the package adopts the already-injected blob). The assertions are identical either way,
which is the point of the integration.
"""

import contextlib
import io
import logging
import os

import varlock

env = varlock.load()

# values are coerced, not raw strings
assert env["PORT"] == 8080, env["PORT"]
assert env["DEBUG"] is True, env["DEBUG"]
# attribute access reads the same value
assert env.PORT == env["PORT"]
assert env["SECRET"] == "shhh"

# declared-but-unset optional keys are absent, not present as None
assert "OPTIONAL_UNSET" not in env, dict(env)
assert env.get("OPTIONAL_UNSET") is None
try:
    env["OPTIONAL_UNSET"]
    raise AssertionError("expected VarlockMissingKeyError")
except varlock.VarlockMissingKeyError as err:
    assert "no value in this environment" in str(err), str(err)

# unknown keys raise rather than returning None
try:
    env["NOT_IN_SCHEMA"]
    raise AssertionError("expected VarlockMissingKeyError")
except varlock.VarlockMissingKeyError:
    pass

# resolved values are injected as env vars, serialized the way the CLI does it
assert os.environ["PORT"] == "8080", os.environ["PORT"]
assert os.environ["DEBUG"] == "true", os.environ["DEBUG"]
assert "OPTIONAL_UNSET" not in os.environ

# sensitive values never appear in the repr (a notebook echoes it into the saved file)
assert varlock.get_sensitive_keys() == frozenset({"SECRET"})
assert "shhh" not in repr(env), repr(env)

# redaction is installed by load(), since @redactLogs defaults on
assert varlock.redact(f"token={env['SECRET']}") == "token=sh▒▒▒▒▒"
assert "shhh" in varlock.redact(varlock.reveal(env["SECRET"]))

captured = io.StringIO()
with contextlib.redirect_stdout(captured):
    print(f"leaking {env['SECRET']}")
    logging.getLogger("smoke").warning("also %s", env["SECRET"])
assert "shhh" not in captured.getvalue(), captured.getvalue()

try:
    varlock.scan_for_leaks(f'{{"token": "{env["SECRET"]}"}}')
    raise AssertionError("expected VarlockLeakError")
except varlock.VarlockLeakError as err:
    assert err.key == "SECRET"

expect_under_run = os.environ.get("EXPECT_VARLOCK_RUN") == "1"
assert varlock.is_running_under_varlock_run() is expect_under_run

print("OK")
