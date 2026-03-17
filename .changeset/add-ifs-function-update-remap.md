---
"varlock": minor
"@env-spec/parser": minor
---

feat: add `ifs()` function and update `remap()` to support positional arg pairs

- **New `ifs()` function**: Excel-style conditional that evaluates condition/value pairs and returns the value for the first truthy condition. An optional trailing default value is used when no condition matches.

  ```env-spec
  API_URL=ifs(
    eq($ENV, production), https://api.example.com,
    eq($ENV, staging), https://staging-api.example.com,
    http://localhost:3000
  )
  ```

- **Updated `remap()` function**: Now supports positional `(match, result)` pairs as the preferred syntax. The old key=value syntax (`result=match`) is still supported but deprecated.

  ```env-spec
  # new preferred syntax (match first, result second)
  APP_ENV=remap($CI_BRANCH, "main", production, regex(.*), preview, undefined, development)

  # old syntax (still works but deprecated)
  APP_ENV=remap($CI_BRANCH, production="main", preview=regex(.*), development=undefined)
  ```
