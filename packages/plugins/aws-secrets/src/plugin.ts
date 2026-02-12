import { Resolver } from 'varlock/plugin-lib';

import {
  SecretsManagerClient,
  GetSecretValueCommand,
  type GetSecretValueCommandOutput,
} from '@aws-sdk/client-secrets-manager';
import {
  SSMClient,
  GetParameterCommand,
  type GetParameterCommandOutput,
} from '@aws-sdk/client-ssm';
import { fromIni } from '@aws-sdk/credential-providers';

const { ValidationError, SchemaError, ResolutionError } = plugin.ERRORS;

const AWS_ICON = 'skill-icons:aws-dark';

plugin.name = 'aws';
const { debug } = plugin;
debug('init - version =', plugin.version);
plugin.icon = AWS_ICON;

const FIX_AUTH_TIP = [
  'Verify your AWS credentials are configured correctly. Use one of the following options:',
  '  1. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables',
  '  2. Configure ~/.aws/credentials file (run: aws configure)',
  '  3. Provide credentials explicitly via @initAws(accessKeyId=..., secretAccessKey=...)',
  '  4. Use IAM roles (if running on AWS infrastructure)',
].join('\n');

class AwsPluginInstance {
  private region?: string;
  private accessKeyId?: string;
  private secretAccessKey?: string;
  private sessionToken?: string;
  private profile?: string;
  private namePrefix?: string;

  constructor(
    readonly id: string,
  ) {
  }

  setAuth(
    region?: any,
    accessKeyId?: any,
    secretAccessKey?: any,
    sessionToken?: any,
    profile?: any,
    namePrefix?: any,
  ) {
    this.region = region ? String(region) : undefined;
    this.accessKeyId = accessKeyId ? String(accessKeyId) : undefined;
    this.secretAccessKey = secretAccessKey ? String(secretAccessKey) : undefined;
    this.sessionToken = sessionToken ? String(sessionToken) : undefined;
    this.profile = profile;
    this.namePrefix = namePrefix ? String(namePrefix) : undefined;
    debug(
      'aws instance',
      this.id,
      'set auth - region:',
      this.region,
      'profile:',
      this.profile,
      'hasAccessKey:',
      !!this.accessKeyId,
      'hasSecretKey:',
      !!this.secretAccessKey,
      'namePrefix:',
      this.namePrefix,
    );
  }

  applyNamePrefix(name: string): string {
    if (this.namePrefix) {
      return this.namePrefix + name;
    }
    return name;
  }

  private secretsManagerClientPromise: Promise<SecretsManagerClient> | undefined;
  async initSecretsManagerClient() {
    if (this.secretsManagerClientPromise) return this.secretsManagerClientPromise;

    this.secretsManagerClientPromise = (async () => {
      try {
        const clientConfig: any = {
          region: this.region,
        };

        if (this.accessKeyId && this.secretAccessKey) {
          // Use explicit credentials
          clientConfig.credentials = {
            accessKeyId: this.accessKeyId,
            secretAccessKey: this.secretAccessKey,
            sessionToken: this.sessionToken,
          };
          debug('Using explicit AWS credentials');
        } else if (this.profile) {
          // Use named profile from ~/.aws/credentials
          clientConfig.credentials = fromIni({ profile: this.profile });
          debug('Using AWS profile:', this.profile);
        } else {
          // Use default AWS credential chain (env vars, ~/.aws/credentials, IAM roles)
          debug('Using default AWS credential chain');
        }

        const client = new SecretsManagerClient(clientConfig);
        debug('AWS Secrets Manager client initialized for instance', this.id);
        return client;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        throw new SchemaError(`Failed to initialize AWS Secrets Manager client: ${errorMsg}`, {
          tip: FIX_AUTH_TIP,
        });
      }
    })();

    return this.secretsManagerClientPromise;
  }

  private ssmClientPromise: Promise<SSMClient> | undefined;
  async initSSMClient() {
    if (this.ssmClientPromise) return this.ssmClientPromise;

    this.ssmClientPromise = (async () => {
      try {
        const clientConfig: any = {
          region: this.region,
        };

        if (this.accessKeyId && this.secretAccessKey) {
          // Use explicit credentials
          clientConfig.credentials = {
            accessKeyId: this.accessKeyId,
            secretAccessKey: this.secretAccessKey,
            sessionToken: this.sessionToken,
          };
          debug('Using explicit AWS credentials');
        } else if (this.profile) {
          // Use named profile from ~/.aws/credentials
          clientConfig.credentials = fromIni({ profile: this.profile });
          debug('Using AWS profile:', this.profile);
        } else {
          // Use default AWS credential chain (env vars, ~/.aws/credentials, IAM roles)
          debug('Using default AWS credential chain');
        }

        const client = new SSMClient(clientConfig);
        debug('AWS SSM client initialized for instance', this.id);
        return client;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        throw new SchemaError(`Failed to initialize AWS SSM client: ${errorMsg}`, {
          tip: FIX_AUTH_TIP,
        });
      }
    })();

    return this.ssmClientPromise;
  }

  async getSecret(secretId: string, jsonKey?: string): Promise<string> {
    const client = await this.initSecretsManagerClient();
    if (!client) throw new Error('Expected AWS Secrets Manager client to be initialized');

    try {
      const command = new GetSecretValueCommand({ SecretId: secretId });
      const response: GetSecretValueCommandOutput = await client.send(command);

      // Return SecretString if available, otherwise decode SecretBinary
      let secretValue: string;
      if (response.SecretString) {
        secretValue = response.SecretString;
      } else if (response.SecretBinary) {
        // Decode binary secret
        const buff = Buffer.from(response.SecretBinary);
        secretValue = buff.toString('utf-8');
      } else {
        throw new ResolutionError('Secret data is empty');
      }

      // If a JSON key is specified, parse and extract it
      if (jsonKey) {
        try {
          const parsed = JSON.parse(secretValue);
          if (!(jsonKey in parsed)) {
            throw new ResolutionError(`Key "${jsonKey}" not found in secret JSON`, {
              tip: `Available keys: ${Object.keys(parsed).join(', ')}`,
            });
          }
          return String(parsed[jsonKey]);
        } catch (err) {
          if (err instanceof ResolutionError) throw err;
          throw new ResolutionError(`Failed to parse secret as JSON: ${err instanceof Error ? err.message : String(err)}`, {
            tip: 'Ensure the secret value is valid JSON when extracting a specific key',
          });
        }
      }

      return secretValue;
    } catch (err: any) {
      // Re-throw ResolutionError as-is
      if (err instanceof ResolutionError) {
        throw err;
      }

      let errorMessage = 'Failed to fetch secret';
      let errorTip: string | undefined;

      // Handle common AWS Secrets Manager errors
      const errorName = err.name || err.__type || '';
      const errorCode = err.$metadata?.httpStatusCode;

      if (errorName === 'ResourceNotFoundException' || errorCode === 404) {
        errorMessage = `Secret "${secretId}" not found`;
        errorTip = [
          'Verify the secret exists in AWS Secrets Manager',
          `AWS Console: https://console.aws.amazon.com/secretsmanager/home?region=${this.region || 'us-east-1'}`,
        ].join('\n');
      } else if (errorName === 'AccessDeniedException' || errorCode === 403) {
        errorMessage = `Permission denied accessing secret "${secretId}"`;
        errorTip = [
          'Ensure your IAM user/role has the required permissions',
          'Required IAM policy:',
          '{',
          '  "Effect": "Allow",',
          '  "Action": ["secretsmanager:GetSecretValue"],',
          `  "Resource": "arn:aws:secretsmanager:${this.region || '*'}:*:secret:*"`,
          '}',
        ].join('\n');
      } else if (errorName === 'InvalidRequestException') {
        errorMessage = `Invalid request for secret "${secretId}"`;
        errorTip = [
          'Check the secret ID format:',
          '  - Name: "my-secret"',
          '  - ARN: "arn:aws:secretsmanager:region:account-id:secret:name-AbCdEf"',
          '  - Partial ARN: "name-AbCdEf"',
        ].join('\n');
      } else if (
        errorName.includes('Credential')
        || errorMessage.includes('credentials')
        || errorCode === 401
      ) {
        // Check if we're using explicit credentials or default chain
        if (!this.accessKeyId && !this.profile) {
          errorMessage = 'Authentication failed';
          errorTip = [
            err.message,
            FIX_AUTH_TIP,
          ].join('\n');
        } else {
          errorMessage = 'Authentication failed with provided credentials';
          errorTip = 'Verify that your AWS credentials are valid and have the required permissions';
        }
      } else if (err.message) {
        errorMessage = `AWS Secrets Manager error: ${err.message}`;
      }

      throw new ResolutionError(errorMessage, {
        tip: errorTip,
      });
    }
  }

  async getParameter(name: string, jsonKey?: string): Promise<string> {
    const client = await this.initSSMClient();
    if (!client) throw new Error('Expected AWS SSM client to be initialized');

    try {
      const command = new GetParameterCommand({
        Name: name,
        WithDecryption: true,
      });
      const response: GetParameterCommandOutput = await client.send(command);

      if (!response.Parameter?.Value) {
        throw new ResolutionError('Parameter value is empty');
      }

      const paramValue = response.Parameter.Value;

      // If a JSON key is specified, parse and extract it
      if (jsonKey) {
        try {
          const parsed = JSON.parse(paramValue);
          if (!(jsonKey in parsed)) {
            throw new ResolutionError(`Key "${jsonKey}" not found in parameter JSON`, {
              tip: `Available keys: ${Object.keys(parsed).join(', ')}`,
            });
          }
          return String(parsed[jsonKey]);
        } catch (err) {
          if (err instanceof ResolutionError) throw err;
          throw new ResolutionError(`Failed to parse parameter as JSON: ${err instanceof Error ? err.message : String(err)}`, {
            tip: 'Ensure the parameter value is valid JSON when using the # syntax for key extraction',
          });
        }
      }

      return paramValue;
    } catch (err: any) {
      // Re-throw ResolutionError as-is
      if (err instanceof ResolutionError) {
        throw err;
      }

      let errorMessage = 'Failed to fetch parameter';
      let errorTip: string | undefined;

      // Handle common AWS Parameter Store errors
      const errorName = err.name || err.__type || '';
      const errorCode = err.$metadata?.httpStatusCode;

      if (errorName === 'ParameterNotFound' || errorCode === 404) {
        errorMessage = `Parameter "${name}" not found`;
        errorTip = [
          'Verify the parameter exists in AWS Systems Manager Parameter Store',
          `AWS Console: https://console.aws.amazon.com/systems-manager/parameters?region=${this.region || 'us-east-1'}`,
        ].join('\n');
      } else if (errorName === 'AccessDeniedException' || errorCode === 403) {
        errorMessage = `Permission denied accessing parameter "${name}"`;
        errorTip = [
          'Ensure your IAM user/role has the required permissions',
          'Required IAM policy:',
          '{',
          '  "Effect": "Allow",',
          '  "Action": ["ssm:GetParameter"],',
          `  "Resource": "arn:aws:ssm:${this.region || '*'}:*:parameter/*"`,
          '}',
        ].join('\n');
      } else if (
        errorName.includes('Credential')
        || errorMessage.includes('credentials')
        || errorCode === 401
      ) {
        // Check if we're using explicit credentials or default chain
        if (!this.accessKeyId && !this.profile) {
          errorMessage = 'Authentication failed';
          errorTip = [
            err.message,
            FIX_AUTH_TIP,
          ].join('\n');
        } else {
          errorMessage = 'Authentication failed with provided credentials';
          errorTip = 'Verify that your AWS credentials are valid and have the required permissions';
        }
      } else if (err.message) {
        errorMessage = `AWS Parameter Store error: ${err.message}`;
      }

      throw new ResolutionError(errorMessage, {
        tip: errorTip,
      });
    }
  }
}

const pluginInstances: Record<string, AwsPluginInstance> = {};

plugin.registerRootDecorator({
  name: 'initAws',
  description: 'Initialize an AWS plugin instance for awsSecret() and awsParam() resolvers',
  isFunction: true,
  async process(argsVal) {
    const objArgs = argsVal.objArgs;
    if (!objArgs) throw new SchemaError('Expected some args');

    // Validate id is static
    if (objArgs.id && !objArgs.id.isStatic) {
      throw new SchemaError('Expected id to be static');
    }
    const id = String(objArgs?.id?.staticValue || '_default');
    if (pluginInstances[id]) {
      throw new SchemaError(`Instance with id "${id}" already initialized`);
    }

    // Validate profile is static
    if (objArgs.profile && !objArgs.profile.isStatic) {
      throw new SchemaError('Expected profile to be static');
    }
    const profile = objArgs?.profile ? String(objArgs?.profile?.staticValue) : undefined;

    // Region is required
    if (!objArgs.region) {
      throw new SchemaError('region parameter is required');
    }

    pluginInstances[id] = new AwsPluginInstance(id);

    return {
      id,
      profile,
      regionResolver: objArgs.region,
      accessKeyIdResolver: objArgs.accessKeyId,
      secretAccessKeyResolver: objArgs.secretAccessKey,
      sessionTokenResolver: objArgs.sessionToken,
      namePrefixResolver: objArgs.namePrefix,
    };
  },
  async execute({
    id,
    profile,
    regionResolver,
    accessKeyIdResolver,
    secretAccessKeyResolver,
    sessionTokenResolver,
    namePrefixResolver,
  }) {
    const region = await regionResolver.resolve();
    const accessKeyId = await accessKeyIdResolver?.resolve();
    const secretAccessKey = await secretAccessKeyResolver?.resolve();
    const sessionToken = await sessionTokenResolver?.resolve();
    const namePrefix = await namePrefixResolver?.resolve();
    pluginInstances[id].setAuth(region, accessKeyId, secretAccessKey, sessionToken, profile, namePrefix);
  },
});

plugin.registerDataType({
  name: 'awsAccessKey',
  sensitive: true,
  typeDescription: 'AWS access key ID for IAM authentication',
  icon: AWS_ICON,
  docs: [
    {
      description: 'Managing access keys for IAM users',
      url: 'https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html',
    },
  ],
  async validate(val): Promise<true> {
    if (typeof val !== 'string') {
      throw new ValidationError('Must be a string');
    }
    // AWS access keys are typically 20 characters and alphanumeric
    if (!/^[A-Z0-9]{20}$/.test(val)) {
      throw new ValidationError('Must be a 20-character alphanumeric string (typically starts with AKIA)');
    }
    return true;
  },
});

plugin.registerDataType({
  name: 'awsSecretKey',
  sensitive: true,
  typeDescription: 'AWS secret access key for IAM authentication',
  icon: AWS_ICON,
  docs: [
    {
      description: 'Managing access keys for IAM users',
      url: 'https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html',
    },
  ],
  async validate(val): Promise<true> {
    if (typeof val !== 'string') {
      throw new ValidationError('Must be a string');
    }
    // AWS secret keys are typically 40 characters
    if (val.length !== 40) {
      throw new ValidationError('Must be exactly 40 characters long');
    }
    return true;
  },
});

plugin.registerResolverFunction({
  name: 'awsSecret',
  label: 'Fetch secret from AWS Secrets Manager',
  icon: AWS_ICON,
  argsSchema: {
    type: 'array',
    arrayMinLength: 0,
  },
  process() {
    let instanceId: string;
    let secretIdResolver: Resolver | undefined;
    let inferredSecretName: string | undefined;
    let keyResolver: Resolver | undefined;

    // Check for named 'key' parameter
    if (this.objArgs?.key) {
      keyResolver = this.objArgs.key;
    }

    // No args - auto-infer from parent config item key
    if (!this.arrArgs || this.arrArgs.length === 0) {
      instanceId = '_default';
      const parent = (this as any).parent;
      const itemKey = parent?.key || '';
      if (!itemKey) {
        throw new SchemaError('Could not infer secret name - no parent config item key found', {
          tip: 'Either provide a secret name as an argument, or ensure this is used within a config item',
        });
      }
      // Use item key as-is (AWS allows underscores and mixed case)
      inferredSecretName = itemKey;
    } else if (this.arrArgs.length === 1) {
      instanceId = '_default';
      secretIdResolver = this.arrArgs[0];
    } else if (this.arrArgs.length === 2) {
      if (!(this.arrArgs[0].isStatic)) {
        throw new SchemaError('Expected instance id to be a static value');
      } else {
        instanceId = String(this.arrArgs[0].staticValue);
      }
      secretIdResolver = this.arrArgs[1];
    } else {
      throw new SchemaError('Expected 0, 1, or 2 args');
    }

    if (!Object.values(pluginInstances).length) {
      throw new SchemaError('No AWS plugin instances found', {
        tip: 'Initialize at least one AWS plugin instance using the @initAws root decorator',
      });
    }

    // Make sure instance id is valid
    const selectedInstance = pluginInstances[instanceId];
    if (!selectedInstance) {
      if (instanceId === '_default') {
        throw new SchemaError('AWS plugin instance (without id) not found', {
          tip: [
            'Either remove the `id` param from your @initAws call',
            'or use `awsSecret(id, secretId)` to select an instance by id.',
            `Possible ids are: ${Object.keys(pluginInstances).join(', ')}`,
          ].join('\n'),
        });
      } else {
        throw new SchemaError(`AWS plugin instance id "${instanceId}" not found`, {
          tip: [`Valid ids are: ${Object.keys(pluginInstances).join(', ')}`].join('\n'),
        });
      }
    }

    return {
      instanceId, secretIdResolver, inferredSecretName, keyResolver,
    };
  },
  async resolve({
    instanceId, secretIdResolver, inferredSecretName, keyResolver,
  }) {
    const selectedInstance = pluginInstances[instanceId];

    let secretIdWithKey: string;
    if (inferredSecretName) {
      secretIdWithKey = inferredSecretName;
    } else if (secretIdResolver) {
      const secretId = await secretIdResolver.resolve();
      if (typeof secretId !== 'string') {
        throw new SchemaError('Expected secret ID to resolve to a string');
      }
      secretIdWithKey = secretId;
    } else {
      throw new SchemaError('No secret ID provided or inferred');
    }

    // Parse the secret ID for JSON key extraction (using # syntax)
    let secretId: string;
    let jsonKey: string | undefined;
    const hashIndex = secretIdWithKey.indexOf('#');
    if (hashIndex !== -1) {
      secretId = secretIdWithKey.substring(0, hashIndex);
      jsonKey = secretIdWithKey.substring(hashIndex + 1);
    } else {
      secretId = secretIdWithKey;
    }

    // Named 'key' parameter takes precedence over # syntax
    if (keyResolver) {
      const keyValue = await keyResolver.resolve();
      if (typeof keyValue !== 'string') {
        throw new SchemaError('Expected key parameter to resolve to a string');
      }
      jsonKey = keyValue;
    }

    // Apply namePrefix
    const finalSecretId = selectedInstance.applyNamePrefix(secretId);

    const secretValue = await selectedInstance.getSecret(finalSecretId, jsonKey);
    return secretValue;
  },
});

plugin.registerResolverFunction({
  name: 'awsParam',
  label: 'Fetch parameter from AWS Systems Manager Parameter Store',
  icon: AWS_ICON,
  argsSchema: {
    type: 'array',
    arrayMinLength: 0,
  },
  process() {
    let instanceId: string;
    let parameterNameResolver: Resolver | undefined;
    let inferredParamName: string | undefined;
    let keyResolver: Resolver | undefined;

    // Check for named 'key' parameter
    if (this.objArgs?.key) {
      keyResolver = this.objArgs.key;
    }

    // No args - auto-infer from parent config item key
    if (!this.arrArgs || this.arrArgs.length === 0) {
      instanceId = '_default';
      const parent = (this as any).parent;
      const itemKey = parent?.key || '';
      if (!itemKey) {
        throw new SchemaError('Could not infer parameter name - no parent config item key found', {
          tip: 'Either provide a parameter name as an argument, or ensure this is used within a config item',
        });
      }
      // Use item key as-is (AWS allows underscores and mixed case)
      inferredParamName = itemKey;
    } else if (this.arrArgs.length === 1) {
      instanceId = '_default';
      parameterNameResolver = this.arrArgs[0];
    } else if (this.arrArgs.length === 2) {
      if (!(this.arrArgs[0].isStatic)) {
        throw new SchemaError('Expected instance id to be a static value');
      } else {
        instanceId = String(this.arrArgs[0].staticValue);
      }
      parameterNameResolver = this.arrArgs[1];
    } else {
      throw new SchemaError('Expected 0, 1, or 2 args');
    }

    if (!Object.values(pluginInstances).length) {
      throw new SchemaError('No AWS plugin instances found', {
        tip: 'Initialize at least one AWS plugin instance using the @initAws root decorator',
      });
    }

    // Make sure instance id is valid
    const selectedInstance = pluginInstances[instanceId];
    if (!selectedInstance) {
      if (instanceId === '_default') {
        throw new SchemaError('AWS plugin instance (without id) not found', {
          tip: [
            'Either remove the `id` param from your @initAws call',
            'or use `awsParam(id, parameterName)` to select an instance by id.',
            `Possible ids are: ${Object.keys(pluginInstances).join(', ')}`,
          ].join('\n'),
        });
      } else {
        throw new SchemaError(`AWS plugin instance id "${instanceId}" not found`, {
          tip: [`Valid ids are: ${Object.keys(pluginInstances).join(', ')}`].join('\n'),
        });
      }
    }

    return {
      instanceId, parameterNameResolver, inferredParamName, keyResolver,
    };
  },
  async resolve({
    instanceId, parameterNameResolver, inferredParamName, keyResolver,
  }) {
    const selectedInstance = pluginInstances[instanceId];

    let paramNameWithKey: string;
    if (inferredParamName) {
      paramNameWithKey = inferredParamName;
    } else if (parameterNameResolver) {
      const paramName = await parameterNameResolver.resolve();
      if (typeof paramName !== 'string') {
        throw new SchemaError('Expected parameter name to resolve to a string');
      }
      paramNameWithKey = paramName;
    } else {
      throw new SchemaError('No parameter name provided or inferred');
    }

    // Parse the parameter name for JSON key extraction (using # syntax)
    let parameterName: string;
    let jsonKey: string | undefined;
    const hashIndex = paramNameWithKey.indexOf('#');
    if (hashIndex !== -1) {
      parameterName = paramNameWithKey.substring(0, hashIndex);
      jsonKey = paramNameWithKey.substring(hashIndex + 1);
    } else {
      parameterName = paramNameWithKey;
    }

    // Named 'key' parameter takes precedence over # syntax
    if (keyResolver) {
      const keyValue = await keyResolver.resolve();
      if (typeof keyValue !== 'string') {
        throw new SchemaError('Expected key parameter to resolve to a string');
      }
      jsonKey = keyValue;
    }

    // Apply namePrefix
    const finalParameterName = selectedInstance.applyNamePrefix(parameterName);

    const parameterValue = await selectedInstance.getParameter(finalParameterName, jsonKey);
    return parameterValue;
  },
});
