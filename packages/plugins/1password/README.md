# @varlock/1password-plugin

This package is a [Varlock](https://varlock.dev) [plugin](https://varlock.dev/guides/plugins/) that enables loading data from [1Password](https://1password.com/) into your configuration.

See [our docs site](https://varlock.dev/plugins/1password/) for complete installation and usage instructions.

```env-spec
# Example .env.schema using the 1Password plugin
#
# @plugin(@varlock/1password-plugin)
#
# initialize the plugin, wiring up settings and auth
# @initOp(account=acmeco, token=$OP_TOKEN, allowAppAuth=forEnv(dev))
#
# @currentEnv=$APP_ENV
# @defaultRequired=infer @defaultSensitive=false
# ---

# @type=enum(dev, preview, prod)
APP_ENV=dev

# in deployed environments, this will be used to auth with 1Password
# @sensitive @type=opServiceAccountToken
OP_TOKEN=

# pull items from 1pass using new `op()` resolver
XYZ_API_TOKEN=op("op://api-config/xyz/api-key")
```
