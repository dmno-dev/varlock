---
"@varlock/aws-secrets-plugin": minor
---

`awsSecret()` and `awsParam()` can read nested JSON values with a dot-separated key, such as `awsSecret("db-config#db.host")`. An exact top-level key with the same name still takes precedence.
