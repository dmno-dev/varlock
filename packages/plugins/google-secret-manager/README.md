# @varlock/google-secret-manager-plugin

This package is a [Varlock](https://varlock.dev) [plugin](https://varlock.dev/guides/plugins/) that enables loading secrets from [Google Cloud Secret Manager](https://cloud.google.com/secret-manager) into your configuration.

See [our docs site](https://varlock.dev/plugins/google-secret-manager/) for complete installation and usage instructions.

```env-spec
# Example .env.schema using the Google Secret Manager plugin
#
# @plugin(@varlock/google-secret-manager-plugin)
#
# use Application Default Credentials
# @initGsm(projectId=my-project)
#
# or initialize the plugin with service account credentials
# @initGsm(projectId=my-gcp-project, credentials=$GCP_SA_KEY)
# ---

# Service account JSON key (optional)
# @sensitive @type=gcpServiceAccountJson
GCP_SA_KEY=

# pull secrets from Google Secret Manager using the `gsm()` resolver
API_KEY=gsm("api-key")
DB_PASSWORD=gsm("database-password@5")
```
