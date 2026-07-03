from env import ENV, SENSITIVE_KEYS

assert ENV["PORT"] == 8080, ENV["PORT"]
assert ENV["DEBUG"] is True, ENV["DEBUG"]
assert "SECRET" in SENSITIVE_KEYS
print("OK")
