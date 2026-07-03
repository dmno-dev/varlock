from env import load_env, SENSITIVE_KEYS

ENV = load_env()  # call once, reuse
assert ENV["PORT"] == 8080, ENV["PORT"]
assert ENV["DEBUG"] is True, ENV["DEBUG"]
assert "SECRET" in SENSITIVE_KEYS
print("OK")
