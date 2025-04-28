# env-graph

This is a suite of tools to help load env vars (both schema and values) from multiple sources.

In most cases, this will usually be a set of .env files and actual process vars, for example:
- `.env.schema` - contains schema info and default values
- `.env.local` - contains your git-ignored local overides
- `.env.[env]` - contains environment specific settings
- actual process/shell env vars are applied

All of these sources must be merged together correctly, apply validation/coercion, and resolve to a final set of config, which may be applied as env vars to a script or application.

These sources may use function call style values to pull or transform data using external sources.
But there is no reason we couldn't also pull config values and schema info directly from a remote source - for example a hosted SaaS or a 1Password vault.
Therefore this package aims to handle the problem of loading and combining these sources in a very generic way that allows them to reference each other.

Some more considerations / complex cases:
- both schema and value info from sources must be merged, with specific precedence
- sources can refer to each other (ie one .env file importing another, or picking specific items from another)
- individual values can refer to each other - in simple string templates, or as function args
- plugins / functions may need to be loaded, and may need to access values as well
- in a monorepo, we may want to be able to reference values from another service