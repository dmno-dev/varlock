from env import load_env, SENSITIVE_KEYS

ENV = load_env()  # call once, reuse
assert ENV["PORT"] == 8080, ENV["PORT"]
assert ENV["DEBUG"] is True, ENV["DEBUG"]
# unset optional keys are omitted from the loaded dict (NotRequired = key absent)
assert "OPTIONAL_UNSET" not in ENV, ENV
assert "SECRET" in SENSITIVE_KEYS
print("OK")
