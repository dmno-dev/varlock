import {
  type Resolver, type PluginCacheAccessor, plugin, resolveCacheTtl,
} from 'varlock/plugin-lib';
import { AppConfigurationClient } from '@azure/app-configuration';
import { ClientSecretCredential, DefaultAzureCredential } from '@azure/identity';
import { createHash } from 'node:crypto';

const { SchemaError, ResolutionError } = plugin.ERRORS;

const AZURE_ICON = 'skill-icons:azure-dark';

plugin.name = 'azure-app-configuration';
const { debug } = plugin;
debug('init - version =', plugin.version);
plugin.icon = AZURE_ICON;
plugin.standardVars = {
  initDecorator: '@initAzureAppConfiguration',
  params: {
    endpoint: { key: 'AZURE_APPCONFIG_ENDPOINT' },
    connectionString: {
      key: 'AZURE_APPCONFIG_CONNECTION_STRING',
      dataType: 'azureAppConfigurationConnectionString',
    },
    tenantId: { key: 'AZURE_TENANT_ID' },
    clientId: { key: 'AZURE_CLIENT_ID' },
    clientSecret: { key: 'AZURE_CLIENT_SECRET' },
  },
};

let pluginCache: PluginCacheAccessor | undefined;
try {
  pluginCache = plugin.cache;
} catch {
  // Cache is unavailable when no encryption key is configured.
}

type InstanceConfig = {
  endpoint?: string;
  connectionString?: string;
  tenantId?: string;
  clientId?: string;
  clientSecret?: string;
  defaultLabel?: string;
  defaultKeyFilter?: string;
  trimKeyPrefix?: string;
  allowInsecureConnection?: boolean;
};

function asOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return String(value);
}

function asOptionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new SchemaError(`${name} must be true or false`);
}

function getErrorStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const statusCode = (err as { statusCode?: unknown }).statusCode;
  return typeof statusCode === 'number' ? statusCode : undefined;
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

class AzureAppConfigurationInstance {
  private config: InstanceConfig = {};
  private client?: AppConfigurationClient;
  cacheTtl?: string | number;

  constructor(readonly id: string) {}

  setConfig(config: InstanceConfig) {
    if (config.connectionString && config.endpoint) {
      throw new SchemaError('Provide either connectionString or endpoint, not both');
    }
    if (!config.connectionString && !config.endpoint) {
      throw new SchemaError('Azure App Configuration connectionString or endpoint is required');
    }

    const explicitCredentialValues = [config.tenantId, config.clientId, config.clientSecret];
    const explicitCredentialCount = explicitCredentialValues.filter(Boolean).length;
    if (config.connectionString && explicitCredentialCount) {
      throw new SchemaError('Azure credentials cannot be combined with connectionString');
    }
    if (explicitCredentialCount > 0 && explicitCredentialCount < 3) {
      throw new SchemaError('tenantId, clientId, and clientSecret must be provided together');
    }

    this.config = config;
    const clientOptions = { allowInsecureConnection: config.allowInsecureConnection };
    if (config.connectionString) {
      this.client = new AppConfigurationClient(config.connectionString, clientOptions);
    } else {
      const credential = explicitCredentialCount === 3
        ? new ClientSecretCredential(config.tenantId!, config.clientId!, config.clientSecret!)
        : new DefaultAzureCredential();
      this.client = new AppConfigurationClient(config.endpoint!, credential, clientOptions);
    }

    debug(
      'azure app configuration instance',
      this.id,
      'set config - auth mode:',
      this.telemetryAuthMode,
      'hasDefaultLabel:',
      config.defaultLabel !== undefined,
      'hasDefaultKeyFilter:',
      config.defaultKeyFilter !== undefined,
      'hasTrimKeyPrefix:',
      config.trimKeyPrefix !== undefined,
    );
  }

  get telemetryAuthMode(): 'connection_string' | 'service_principal' | 'default_credential' {
    if (this.config.connectionString) return 'connection_string';
    if (this.config.clientSecret) return 'service_principal';
    return 'default_credential';
  }

  get telemetryBulkDefaults() {
    return !!(this.config.defaultKeyFilter || this.config.trimKeyPrefix);
  }

  get cacheIdentity(): string {
    return createHash('sha256')
      .update(JSON.stringify([
        this.config.endpoint || this.config.connectionString,
        this.config.defaultLabel,
        this.config.defaultKeyFilter,
        this.config.trimKeyPrefix,
      ]))
      .digest('hex')
      .slice(0, 12);
  }

  private getClient(): AppConfigurationClient {
    if (!this.client) throw new SchemaError('Azure App Configuration plugin instance has not been initialized');
    return this.client;
  }

  private handleError(err: unknown, operation: string): never {
    if (err instanceof ResolutionError || err instanceof SchemaError) throw err;

    const status = getErrorStatus(err);
    if (status === 404) {
      throw new ResolutionError(`${operation} was not found`, {
        tip: 'Check the setting key and label in Azure App Configuration',
      });
    }
    if (status === 401) {
      throw new ResolutionError('Azure App Configuration authentication failed', {
        tip: 'Check the connection string or Azure credentials used by the plugin',
      });
    }
    if (status === 403) {
      throw new ResolutionError(`Permission denied while ${operation}`, {
        tip: 'Grant the identity the App Configuration Data Reader role on the configuration store',
      });
    }
    throw new ResolutionError(`Azure App Configuration error while ${operation}: ${getErrorMessage(err)}`);
  }

  async getSetting(key: string, label?: string): Promise<string> {
    try {
      const setting = await this.getClient().getConfigurationSetting({
        key,
        label: label ?? this.config.defaultLabel,
      });
      if (setting.value === undefined) {
        throw new ResolutionError(`Azure App Configuration setting "${key}" has no value`);
      }
      return setting.value;
    } catch (err) {
      return this.handleError(err, `reading setting "${key}"`);
    }
  }

  async getSettings(
    keyFilter?: string,
    labelFilter?: string,
    trimKeyPrefix?: string,
  ): Promise<string> {
    const selectedKeyFilter = keyFilter ?? this.config.defaultKeyFilter ?? '*';
    // Azure uses the NUL filter to select settings without a label.
    const selectedLabelFilter = labelFilter ?? this.config.defaultLabel ?? '\0';
    const selectedTrimPrefix = trimKeyPrefix ?? this.config.trimKeyPrefix;

    try {
      const values: Record<string, string> = Object.create(null);
      const settings = this.getClient().listConfigurationSettings({
        keyFilter: selectedKeyFilter,
        labelFilter: selectedLabelFilter,
      });
      for await (const setting of settings) {
        if (setting.value === undefined) continue;
        const key = selectedTrimPrefix && setting.key.startsWith(selectedTrimPrefix)
          ? setting.key.slice(selectedTrimPrefix.length)
          : setting.key;
        if (Object.hasOwn(values, key)) {
          throw new ResolutionError(`Multiple Azure App Configuration settings map to key "${key}"`, {
            tip: 'Use a narrower keyFilter or labelFilter',
          });
        }
        values[key] = setting.value;
      }
      return JSON.stringify(values);
    } catch (err) {
      return this.handleError(err, `listing settings matching "${selectedKeyFilter}"`);
    }
  }
}

const pluginInstances: Record<string, AzureAppConfigurationInstance> = {};

function getPluginInstance(instanceId: string, resolverName: string): AzureAppConfigurationInstance {
  if (!Object.keys(pluginInstances).length) {
    throw new SchemaError('No Azure App Configuration plugin instances found', {
      tip: `Initialize an instance using @initAzureAppConfiguration() before using ${resolverName}()`,
    });
  }

  const instance = pluginInstances[instanceId];
  if (instance) return instance;

  throw new SchemaError(`Azure App Configuration plugin instance id "${instanceId}" not found`, {
    tip: `Available ids: ${Object.keys(pluginInstances).join(', ')}`,
  });
}

function parseInstanceAndValueArgs(
  resolverCtx: { arrArgs?: Array<Resolver> },
  resolverName: string,
): { instanceId: string; valueResolver?: Resolver; inferredKey?: string } {
  const arrArgs = resolverCtx.arrArgs || [];
  let instanceId = '_default';
  let valueResolver: Resolver | undefined;
  let inferredKey: string | undefined;

  if (arrArgs.length === 0) {
    const parent = (resolverCtx as any).parent;
    if (parent && typeof parent.key === 'string') inferredKey = parent.key;
  } else if (arrArgs.length === 1) {
    valueResolver = arrArgs[0];
  } else if (arrArgs.length === 2) {
    if (!arrArgs[0].isStatic) throw new SchemaError('Expected instance id to be a static value');
    instanceId = String(arrArgs[0].staticValue);
    valueResolver = arrArgs[1];
  } else {
    throw new SchemaError(`Expected ${resolverName}() to receive 0-2 positional arguments`);
  }

  if (!valueResolver && !inferredKey) {
    throw new SchemaError(`${resolverName}() must be used on a config item when called without arguments`);
  }
  getPluginInstance(instanceId, resolverName);
  return { instanceId, valueResolver, inferredKey };
}

async function resolveString(resolver: Resolver | undefined, label: string): Promise<string | undefined> {
  if (!resolver) return undefined;
  const value = await resolver.resolve();
  if (typeof value !== 'string') throw new SchemaError(`Expected ${label} to resolve to a string`);
  return value;
}

plugin.registerRootDecorator({
  name: 'initAzureAppConfiguration',
  description: 'Initialize an Azure App Configuration plugin instance',
  isFunction: true,
  async process(argsVal) {
    const objArgs = argsVal.objArgs;
    if (!objArgs) throw new SchemaError('Expected configuration arguments');
    if (objArgs.id && !objArgs.id.isStatic) throw new SchemaError('Expected id to be static');

    const id = String(objArgs.id?.staticValue || '_default');
    if (pluginInstances[id]) throw new SchemaError(`Instance with id "${id}" already initialized`);
    pluginInstances[id] = new AzureAppConfigurationInstance(id);

    return {
      id,
      endpointResolver: objArgs.endpoint,
      connectionStringResolver: objArgs.connectionString,
      tenantIdResolver: objArgs.tenantId,
      clientIdResolver: objArgs.clientId,
      clientSecretResolver: objArgs.clientSecret,
      defaultLabelResolver: objArgs.defaultLabel,
      defaultKeyFilterResolver: objArgs.defaultKeyFilter,
      trimKeyPrefixResolver: objArgs.trimKeyPrefix,
      allowInsecureConnectionResolver: objArgs.allowInsecureConnection,
      cacheTtlResolver: objArgs.cacheTtl,
    };
  },
  async execute({
    id,
    endpointResolver,
    connectionStringResolver,
    tenantIdResolver,
    clientIdResolver,
    clientSecretResolver,
    defaultLabelResolver,
    defaultKeyFilterResolver,
    trimKeyPrefixResolver,
    allowInsecureConnectionResolver,
    cacheTtlResolver,
  }) {
    pluginInstances[id].setConfig({
      endpoint: asOptionalString(await endpointResolver?.resolve()),
      connectionString: asOptionalString(await connectionStringResolver?.resolve()),
      tenantId: asOptionalString(await tenantIdResolver?.resolve()),
      clientId: asOptionalString(await clientIdResolver?.resolve()),
      clientSecret: asOptionalString(await clientSecretResolver?.resolve()),
      defaultLabel: asOptionalString(await defaultLabelResolver?.resolve()),
      defaultKeyFilter: asOptionalString(await defaultKeyFilterResolver?.resolve()),
      trimKeyPrefix: asOptionalString(await trimKeyPrefixResolver?.resolve()),
      allowInsecureConnection: asOptionalBoolean(
        await allowInsecureConnectionResolver?.resolve(),
        'allowInsecureConnection',
      ),
    });
    const cacheTtl = await resolveCacheTtl(cacheTtlResolver);
    if (cacheTtl !== undefined) pluginInstances[id].cacheTtl = cacheTtl;
  },
});

plugin.registerDataType({
  name: 'azureAppConfigurationConnectionString',
  sensitive: true,
  internal: true,
  typeDescription: 'Azure App Configuration access key connection string',
  icon: AZURE_ICON,
});

plugin.registerResolverFunction({
  name: 'azureAppConfig',
  label: 'Fetch setting from Azure App Configuration',
  icon: AZURE_ICON,
  argsSchema: { type: 'mixed', arrayMinLength: 0, arrayMaxLength: 2 },
  process() {
    const parsed = parseInstanceAndValueArgs(this, 'azureAppConfig');
    return { ...parsed, labelResolver: this.objArgs?.label };
  },
  async resolve({
    instanceId, valueResolver, inferredKey, labelResolver,
  }) {
    const key = await resolveString(valueResolver, 'setting key') ?? inferredKey!;
    const label = await resolveString(labelResolver, 'setting label');
    const instance = getPluginInstance(instanceId, 'azureAppConfig');
    const cacheKey = `azureAppConfig:${JSON.stringify([instanceId, instance.cacheIdentity, key, label])}`;
    if (instance.cacheTtl !== undefined && pluginCache) {
      return pluginCache.getOrSet(cacheKey, instance.cacheTtl, () => instance.getSetting(key, label));
    }
    return instance.getSetting(key, label);
  },
});

plugin.registerResolverFunction({
  name: 'azureAppConfigBulk',
  label: 'Load settings from Azure App Configuration',
  icon: AZURE_ICON,
  argsSchema: { type: 'mixed', arrayMinLength: 0, arrayMaxLength: 1 },
  process() {
    let instanceId = '_default';
    if (this.arrArgs?.length) {
      if (!this.arrArgs[0].isStatic) throw new SchemaError('Expected instance id to be a static value');
      instanceId = String(this.arrArgs[0].staticValue);
    }
    getPluginInstance(instanceId, 'azureAppConfigBulk');
    return {
      instanceId,
      keyFilterResolver: this.objArgs?.keyFilter,
      labelFilterResolver: this.objArgs?.labelFilter,
      trimKeyPrefixResolver: this.objArgs?.trimKeyPrefix,
    };
  },
  async resolve({
    instanceId, keyFilterResolver, labelFilterResolver, trimKeyPrefixResolver,
  }) {
    const keyFilter = await resolveString(keyFilterResolver, 'keyFilter');
    const labelFilter = await resolveString(labelFilterResolver, 'labelFilter');
    const trimKeyPrefix = await resolveString(trimKeyPrefixResolver, 'trimKeyPrefix');
    const instance = getPluginInstance(instanceId, 'azureAppConfigBulk');
    const cacheKey = `azureAppConfigBulk:${JSON.stringify([instanceId, instance.cacheIdentity, keyFilter, labelFilter, trimKeyPrefix])}`;
    if (instance.cacheTtl !== undefined && pluginCache) {
      return pluginCache.getOrSet(
        cacheKey,
        instance.cacheTtl,
        () => instance.getSettings(keyFilter, labelFilter, trimKeyPrefix),
      );
    }
    return instance.getSettings(keyFilter, labelFilter, trimKeyPrefix);
  },
});

plugin.registerTelemetryAttributes(() => {
  const instances = Object.values(pluginInstances);
  const authModes = new Set(instances.map((instance) => instance.telemetryAuthMode));
  return {
    instance_count: instances.length,
    cache_enabled: instances.some((instance) => instance.cacheTtl != null),
    auth_connection_string: authModes.has('connection_string'),
    auth_service_principal: authModes.has('service_principal'),
    auth_default_credential: authModes.has('default_credential'),
    bulk_defaults_configured: instances.some((instance) => instance.telemetryBulkDefaults),
  };
});
