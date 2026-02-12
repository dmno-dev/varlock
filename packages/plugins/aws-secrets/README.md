# @varlock/aws-secrets-plugin

[![npm version](https://img.shields.io/npm/v/@varlock/aws-secrets-plugin.svg)](https://www.npmjs.com/package/@varlock/aws-secrets-plugin) [![GitHub stars](https://img.shields.io/github/stars/dmno-dev/varlock.svg?style=social&label=Star)](https://github.com/dmno-dev/varlock) [![license](https://img.shields.io/npm/l/@varlock/aws-secrets-plugin.svg)](https://github.com/dmno-dev/varlock/blob/main/LICENSE)

This package is a [Varlock](https://varlock.dev) [plugin](https://varlock.dev/guides/plugins/) that enables loading data from [AWS Secrets Manager](https://aws.amazon.com/secrets-manager/) and [AWS Systems Manager Parameter Store](https://aws.amazon.com/systems-manager/features/#Parameter_Store) into your configuration.

## Features

- **Zero-config authentication** - Automatically uses AWS credentials from your environment
- **IAM role support** - No credentials needed for AWS-hosted apps (EC2, ECS, Lambda, etc.)
- **AWS CLI authentication** - Works seamlessly with `aws configure` for local development
- **Auto-infer secret/parameter names** from environment variable names (uses name as-is)
- **JSON key extraction** from secrets/parameters using `#` syntax or named `key` parameter
- **Name prefixing** with `namePrefix` option for organized secret management
- Support for named AWS profiles
- Support for explicit credentials (access key/secret key)
- Support for temporary credentials (with session tokens)
- Lazy-initialized AWS SDK clients
- Comprehensive error handling with helpful tips

## Installation

If you are in a JavaScript based project and have a package.json file, you can either install the plugin explicitly
```bash
npm install @varlock/aws-secrets-plugin
```
And then register the plugin without any version number
```env-spec title=".env.schema"
# @plugin(@varlock/aws-secrets-plugin)
# ---
```

Otherwise just set the explicit version number when you register it
```env-spec title=".env.schema"
# @plugin(@varlock/aws-secrets-plugin@1.2.3)
# ---
```

See our [Plugin Guide](https://varlock.dev/guides/plugins/#installation) for more details.

## Setup + Auth

After registering the plugin, you must initialize it with the `@initAws` root decorator.

### Automatic auth

For most use cases, you only need to provide the AWS region:

```env-spec
# @plugin(@varlock/aws-secrets-plugin)
# @initAws(region=us-east-1)
# ---
```

**How this works:**

- **Local development:** Run `aws configure` → automatically uses AWS CLI credentials
- **AWS-hosted apps** (EC2, ECS, Lambda, Fargate): Attach an IAM role → automatically authenticates (no secrets needed!)
- **Works everywhere** with zero configuration beyond the region!

### Explicit credentials (For non-AWS environments)

If you're deploying outside of AWS (e.g., Azure, GCP, on-premises), wire up IAM credentials:

```env-spec
# @plugin(@varlock/aws-secrets-plugin)
# @initAws(
#   region=us-east-1,
#   accessKeyId=$AWS_ACCESS_KEY_ID,
#   secretAccessKey=$AWS_SECRET_ACCESS_KEY
# )
# ---

# @type=awsAccessKey
AWS_ACCESS_KEY_ID=

# @type=awsSecretKey @sensitive
AWS_SECRET_ACCESS_KEY=
```

You would then need to inject these env vars using your CI/CD system.

### Authentication Priority

The plugin tries authentication methods in this order:
1. **Explicit credentials** - If `accessKeyId` and `secretAccessKey` are provided
2. **Named profile** - If `profile` is specified, uses credentials from `~/.aws/credentials`
3. **Default AWS credential chain** - Environment variables → `~/.aws/credentials` → IAM roles

### Using Named Profiles

Use a specific profile from your `~/.aws/credentials` file:

```env-spec
# @initAws(region=us-east-1, profile=production)
```

### Multiple instances

If you need to connect to multiple instances with different settings, you can register multiple named instances:

```env-spec
# @initAws(id=us, region=us-east-1)
# @initAws(id=eu, region=eu-west-1, profile=eu-prod)
```

Or use functions to populate in values:

```env-spec
# @initAws(region="${AWS_REGION}")
```

## Reading secrets and parameters

This plugin introduces two functions: `awsSecret()` for AWS Secrets Manager and `awsParam()` for Parameter Store.

```env-spec title=".env.schema"
# @plugin(@varlock/aws-secrets-plugin)
# @initAws(region=us-east-1)
# ---

# Auto-infer secret names (DATABASE_URL -> "DATABASE_URL")
DATABASE_URL=awsSecret()
API_KEY=awsSecret()

# Explicit secret names
STRIPE_KEY=awsSecret("payments/stripe-secret-key")

# Referring to a single key in items holding key/value pairs
# If "database-creds" contains: {"host": "db.example.com", "password": "secret"}
DB_HOST=awsSecret("database-creds#host")
DB_PASSWORD=awsSecret("database-creds#password")

# Or use named "key" parameter
DB_PORT=awsSecret("database-creds", key="port")

# Parameters from Parameter Store
APP_CONFIG=awsParam("/prod/app/config")
FEATURE_FLAGS=awsParam("/prod/features")

# Auto-infer parameter names too
DATABASE_HOST=awsParam()

# If using multiple instances
US_DATABASE_URL=awsSecret(us, "db-connection")
EU_DATABASE_URL=awsSecret(eu, "db-connection")
```

### Name Prefixing

Use `namePrefix` to automatically prefix all secret/parameter names:

```env-spec
# @initAws(region=us-east-1, namePrefix="prod/api/")
# ---

# Fetches "prod/api/DATABASE_URL"
DATABASE_URL=awsSecret()

# Fetches "prod/api/stripe-key"
STRIPE_KEY=awsSecret("stripe-key")
```

You can even use dynamic prefixes:

```env-spec
# @initAws(region=us-east-1, namePrefix="${ENV}/")
# In prod: fetches "prod/DATABASE_URL"
# In dev: fetches "dev/DATABASE_URL"
DATABASE_URL=awsSecret()
```

---

## Reference

### Root decorators

#### `@initAws()`

Initialize an AWS plugin instance.

**Parameters:**

- `region: string` (required) - AWS region (e.g., `us-east-1`, `eu-west-1`)
- `namePrefix?: string` - Prefix automatically prepended to all secret/parameter names
- `accessKeyId?: string` - AWS access key ID for explicit authentication
- `secretAccessKey?: string` - AWS secret access key for explicit authentication
- `sessionToken?: string` - AWS session token for temporary credentials
- `profile?: string` - Named profile from `~/.aws/credentials`
- `id?: string` - Instance identifier for multiple instances (defaults to `_default`)

### Functions

#### `awsSecret()`

Fetch a secret from AWS Secrets Manager.

**Signatures:**

- `awsSecret()` - Auto-infers secret name from variable name (uses name as-is)
- `awsSecret(secretId)` - Fetch by explicit secret name/ID
- `awsSecret(secretId, key="jsonKey")` - Fetch and extract JSON key
- `awsSecret(instanceId, secretId)` - Fetch from a specific instance

**Secret ID Formats:**

- Name: `"my-secret"`
- Name with JSON key: `"my-secret#password"` (shorthand for key extraction)
- ARN: `"arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret-AbCdEf"`

#### `awsParam()`

Fetch a parameter from AWS Systems Manager Parameter Store.

**Signatures:**

- `awsParam()` - Auto-infers parameter name from variable name (uses name as-is)
- `awsParam(parameterName)` - Fetch by explicit parameter name/path
- `awsParam(parameterName, key="jsonKey")` - Fetch and extract JSON key
- `awsParam(instanceId, parameterName)` - Fetch from a specific instance

**Parameter Formats:**

- Simple: `"MyParameter"`
- Path: `"/prod/app/database-url"`
- Hierarchical: `"/team/service/env/config"`
- With JSON key: `"/prod/db/creds#password"`

### Data Types

- `awsAccessKey` - AWS access key ID (20-character alphanumeric, sensitive)
- `awsSecretKey` - AWS secret access key (40 characters, sensitive)

---

## AWS Setup

### Required IAM Permissions

#### For AWS Secrets Manager

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["secretsmanager:GetSecretValue"],
      "Resource": "arn:aws:secretsmanager:*:*:secret:*"
    }
  ]
}
```

#### For AWS Systems Manager Parameter Store

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["ssm:GetParameter"],
      "Resource": "arn:aws:ssm:*:*:parameter/*"
    }
  ]
}
```

### Attach IAM Role (Recommended for AWS-hosted apps)

IAM roles are the AWS-native way to authenticate - no credentials needed!

**For EC2 instances:**

```bash
# Create role with trust policy for EC2
aws iam create-role \
  --role-name varlock-secrets-reader \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": {"Service": "ec2.amazonaws.com"},
      "Action": "sts:AssumeRole"
    }]
  }'

# Attach permissions
aws iam put-role-policy \
  --role-name varlock-secrets-reader \
  --policy-name secrets-access \
  --policy-document file://policy.json

# Create and attach instance profile
aws iam create-instance-profile --instance-profile-name varlock-secrets-reader
aws iam add-role-to-instance-profile \
  --instance-profile-name varlock-secrets-reader \
  --role-name varlock-secrets-reader

# Attach to EC2 instance
aws ec2 associate-iam-instance-profile \
  --instance-id i-1234567890abcdef0 \
  --iam-instance-profile Name=varlock-secrets-reader
```

**For ECS tasks:**

```bash
# Create role with trust policy for ECS
aws iam create-role \
  --role-name varlock-ecs-task-role \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": {"Service": "ecs-tasks.amazonaws.com"},
      "Action": "sts:AssumeRole"
    }]
  }'

# Attach permissions
aws iam put-role-policy \
  --role-name varlock-ecs-task-role \
  --policy-name secrets-access \
  --policy-document file://policy.json

# Reference in task definition
# "taskRoleArn": "arn:aws:iam::123456789012:role/varlock-ecs-task-role"
```

**For Lambda functions:**

```bash
# Create role with trust policy for Lambda
aws iam create-role \
  --role-name varlock-lambda-role \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": {"Service": "lambda.amazonaws.com"},
      "Action": "sts:AssumeRole"
    }]
  }'

# Attach permissions
aws iam put-role-policy \
  --role-name varlock-lambda-role \
  --policy-name secrets-access \
  --policy-document file://policy.json

# Attach to Lambda function
aws lambda update-function-configuration \
  --function-name my-function \
  --role arn:aws:iam::123456789012:role/varlock-lambda-role
```

That's it! Your app will now automatically authenticate using the IAM role.

### Create IAM User (For non-AWS environments)

```bash
# Create IAM user
aws iam create-user --user-name varlock-secrets-reader

# Attach policy
aws iam put-user-policy \
  --user-name varlock-secrets-reader \
  --policy-name secrets-access \
  --policy-document file://policy.json

# Create access key
aws iam create-access-key --user-name varlock-secrets-reader
```

Save the `AccessKeyId` and `SecretAccessKey` from the output - you'll need them for non-AWS deployments.

### Configure AWS CLI

For local development:

```bash
aws configure
# AWS Access Key ID: [your key]
# AWS Secret Access Key: [your secret]
# Default region name: us-east-1
# Default output format: json
```

Or manually create `~/.aws/credentials`:

```ini
[default]
aws_access_key_id = AKIAIOSFODNN7EXAMPLE
aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY

[production]
aws_access_key_id = AKIAI44QH8DHBEXAMPLE
aws_secret_access_key = je7MtGbClwBF/2Zp9Utk/h3yCo8nvbEXAMPLEKEY
```

## Troubleshooting

### Secret not found
- Verify the secret exists: `aws secretsmanager list-secrets --query 'SecretList[?Name==\`my-secret\`]'`
- Check you're using the correct region: `aws secretsmanager get-secret-value --secret-id my-secret --region us-east-1`

### Parameter not found
- Verify the parameter exists: `aws ssm describe-parameters --parameter-filters "Key=Name,Values=/my/param"`
- Check you're using the correct region

### Permission denied
- Check your IAM permissions: `aws iam get-user-policy --user-name varlock-secrets-reader --policy-name secrets-access`
- For IAM roles on EC2: `aws sts get-caller-identity` (run from the instance to see what role is attached)
- Ensure the IAM policy includes the required actions (`secretsmanager:GetSecretValue` and/or `ssm:GetParameter`)

### Authentication failed
- **Local dev:** Run `aws configure` or ensure `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` are set
- **AWS-hosted apps:** Verify IAM role is attached and has the required permissions
- **Other environments:** Verify credentials are correct and properly injected
- Test credentials: `aws sts get-caller-identity`
