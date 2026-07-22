from env import load_env, SENSITIVE_KEYS

ENV = load_env()
assert ENV["PORT"] == 8080, ENV["PORT"]
assert ENV["DEBUG"] is True, ENV["DEBUG"]
assert "OPTIONAL_UNSET" not in ENV, ENV
assert "SECRET" in SENSITIVE_KEYS
print("OK")
