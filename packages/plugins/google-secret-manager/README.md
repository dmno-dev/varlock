# @varlock/google-secret-manager-plugin

Load secrets from [Google Cloud Secret Manager](https://cloud.google.com/secret-manager) into your Varlock configuration using declarative instructions in your `.env.schema` files.

## Features

- ✅ Fetch secrets from Google Cloud Secret Manager
- ✅ Auto-name secrets using config item keys
- ✅ Application Default Credentials (ADC) or Service Account authentication
- ✅ Versioned secret access (latest or specific version)
- ✅ Multiple plugin instances for different projects
- ✅ Full secret path support
- ✅ Helpful error messages with resolution tips

## Installation

If you are in a JavaScript based project and have a package.json file, you can either install the plugin explicitly
```bash
npm install @varlock/google-secret-manager-plugin
```
And then register the plugin without any version number
```env-spec title=".env.schema"
# @plugin(@varlock/google-secret-manager-plugin)
# ---
```

Otherwise just set the explicit version number when you register it
```env-spec title=".env.schema"
# @plugin(@varlock/google-secret-manager-plugin@1.2.3)
# ---
```

See our [Plugin Guide](https://varlock.dev/guides/plugins/#installation) for more details.

## Setup + Auth

After registering the plugin, you must initialize it with the `@initGsm` root decorator.

### Application Default Credentials (Recommended)

The simplest setup uses Application Default Credentials:

```env-spec
# @plugin(@varlock/google-secret-manager-plugin)
# @initGsm(projectId=my-gcp-project)
# ---
```

**Setting up ADC:**

```bash
# Login and set up application default credentials
gcloud auth application-default login

# Or set the environment variable to a service account key file
export GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account-key.json"
```

### Service Account Credentials

For explicit service account authentication:

```env-spec
# @plugin(@varlock/google-secret-manager-plugin)
# @initGsm(projectId=my-gcp-project, credentials=$GCP_SA_KEY)
# ---

# @type=gcpServiceAccountJson @sensitive
GCP_SA_KEY=
```

The `credentials` parameter accepts:
- JSON string containing the service account key
- Object with the parsed service account key
- If omitted, uses Application Default Credentials

### Multiple Instances

Connect to multiple GCP projects:

```env-spec
# @initGsm(id=prod, projectId=prod-project)
# @initGsm(id=dev, projectId=dev-project)
```

## Usage

### Basic Secret Fetching

Once initialized, use the `gsm()` resolver to fetch secrets:

```env-spec
# @plugin(@varlock/google-secret-manager-plugin)
# @initGsm(projectId=my-project)
# ---

# Secret name defaults to the config item key
SIMPLEST_VAR=gsm()

# Or you can explicitly specify the secret name
RENAMED_VAR=gsm("database-password")

# You can fetch a specific version
API_KEY_LATEST=gsm("api-key@latest")
API_KEY_V5=gsm("api-key@5")

# Use complete resource paths for maximum control:
FULL_PATH_VAR=gsm("projects/my-project/secrets/db-url/versions/3")
```

### Multiple Instances

If you need to connect using different project ids, or different credentials, particularly at the same time,
you can create multiple named instances, and then use that id when fetching secrets.

```env-spec
# @plugin(@varlock/google-secret-manager-plugin)
# @initGsm(id=prod, projectId=prod-project, credentials=$PROD_KEY)
# @initGsm(id=dev, projectId=dev-project, credentials=$DEV_KEY)
# ---

PROD_DATABASE=gsm(prod, "database-url")
DEV_DATABASE=gsm(dev, "database-url")
```

## API Reference

### `@initGsm()`

Root decorator to initialize a Google Secret Manager plugin instance.

**Parameters:**
- `projectId?: string` - GCP project ID (can be inferred from service account credentials)
- `credentials?: string | object` - Service account JSON key (string or object). If omitted, uses Application Default Credentials
- `id?: string` - Instance identifier for multiple instances (defaults to `_default`)

### `gsm()`

Resolver function to fetch secret values.

**Signatures:**
- `gsm()` - Fetch using config item key as secret name from default instance (e.g., `DATABASE_URL=gsm()` will fetch a secret named `DATABASE_URL`)
- `gsm(secretRef)` - Fetch specific secret from default instance
- `gsm(instanceId, secretRef)` - Fetch from named instance

**Secret Reference Formats:**
- `"secret-name"` - Uses latest version from configured project
- `"secret-name@5"` - Specific version from configured project
- `"projects/PROJECT/secrets/NAME/versions/VERSION"` - Full resource path

**Returns:** The secret value as a string

## Data Types

### `gcpServiceAccountJson`

Google Cloud service account JSON key for authentication (marked as sensitive).

**Required fields:**
- `type` - Must be `"service_account"`
- `project_id` - GCP project ID
- `private_key` - Service account private key
- `client_email` - Service account email

## Error Handling

The plugin provides helpful error messages:

- **Secret not found**: Verifies secret exists and is accessible
- **Permission denied**: Suggests granting "Secret Manager Secret Accessor" role
- **Authentication failed**: Provides steps to fix ADC or credential issues
- **Invalid credentials**: Validates service account JSON format

## Google Cloud Setup

### 1. Enable Secret Manager API

```bash
gcloud services enable secretmanager.googleapis.com
```

### 2. Create Secrets

```bash
# Create a secret
echo -n "my-secret-value" | gcloud secrets create SECRET_NAME --data-file=-

# View all secrets
gcloud secrets list

# Access a secret value
gcloud secrets versions access latest --secret="SECRET_NAME"
```

### 3. Grant Access

For Application Default Credentials:

```bash
# Grant yourself access
gcloud secrets add-iam-policy-binding SECRET_NAME \
  --member="user:your-email@example.com" \
  --role="roles/secretmanager.secretAccessor"
```

For Service Accounts:

```bash
# Create service account
gcloud iam service-accounts create varlock-secrets \
  --display-name="Varlock Secrets Access"

# Grant access to secrets
gcloud secrets add-iam-policy-binding SECRET_NAME \
  --member="serviceAccount:varlock-secrets@PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"

# Create and download key
gcloud iam service-accounts keys create key.json \
  --iam-account=varlock-secrets@PROJECT_ID.iam.gserviceaccount.com
```

### 4. (Optional) Grant Project-Wide Access

To allow access to all secrets in a project:

```bash
gcloud projects add-iam-policy-binding PROJECT_ID \
  --member="serviceAccount:varlock-secrets@PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

## Troubleshooting

### Secret not found
- Verify the secret exists: `gcloud secrets list`
- Check you're using the correct project ID
- Ensure the secret name matches exactly (case-sensitive)

### Permission denied
- Grant "Secret Manager Secret Accessor" role to your account or service account
- Verify IAM permissions in Cloud Console
- Check that the secret wasn't deleted

### Authentication failed (ADC)
```bash
# Reinitialize Application Default Credentials
gcloud auth application-default login

# Or set credentials file path
export GOOGLE_APPLICATION_CREDENTIALS="/path/to/key.json"
```

### Authentication failed (Service Account)
- Verify the JSON key is valid and complete
- Check that the service account hasn't been disabled
- Ensure the service account has the required IAM roles

### Project ID required
- Provide `projectId` in `@initGsm()`, or
- Use full secret paths: `projects/PROJECT/secrets/NAME/versions/VERSION`, or
- Include `project_id` in your service account credentials

## Resources

- [Google Cloud Secret Manager Documentation](https://cloud.google.com/secret-manager/docs)
- [Secret Manager Client Libraries](https://cloud.google.com/secret-manager/docs/reference/libraries)
- [IAM Roles for Secret Manager](https://cloud.google.com/secret-manager/docs/access-control)
- [Application Default Credentials](https://cloud.google.com/docs/authentication/application-default-credentials)
- [Service Account Keys](https://cloud.google.com/iam/docs/keys-create-delete)
