import fs from 'node:fs/promises';
import { type Resolver, plugin } from 'varlock/plugin-lib';
import * as k8s from '@kubernetes/client-node';

const { SchemaError, ResolutionError, ValidationError } = plugin.ERRORS;

const KUBERNETES_ICON = 'logos:kubernetes';
const SERVICE_ACCOUNT_NAMESPACE_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/namespace';

plugin.name = 'kubernetes';
const { debug } = plugin;
debug('init - version =', plugin.version);
plugin.icon = KUBERNETES_ICON;
plugin.standardVars = {
  initDecorator: '@initKubernetes',
  params: {
    namespace: { key: ['KUBERNETES_NAMESPACE', 'POD_NAMESPACE'] },
    kubeconfig: { key: 'KUBECONFIG' },
    token: { key: 'KUBERNETES_TOKEN', dataType: 'kubernetesBearerToken' },
  },
};

type KubernetesAuthConfig = {
  namespace?: string;
  context?: string;
  kubeconfig?: string;
  clusterServer?: string;
  token?: string;
  skipTlsVerify?: boolean;
  allowMissing?: boolean;
};

type KubernetesObjectKind = 'Secret' | 'ConfigMap';

function asOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return String(value);
}

function asOptionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  throw new SchemaError(`${name} must be true or false`);
}

function isRawKubeconfig(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith('{') || trimmed.includes('apiVersion:') || trimmed.includes('clusters:');
}

async function readServiceAccountNamespace(): Promise<string | undefined> {
  try {
    const ns = await fs.readFile(SERVICE_ACCOUNT_NAMESPACE_PATH, 'utf-8');
    return ns.trim() || undefined;
  } catch {
    return undefined;
  }
}

function getApiExceptionStatus(err: unknown): number | undefined {
  if (err && typeof err === 'object') {
    const maybe = err as {
      code?: unknown,
      statusCode?: unknown,
      response?: { statusCode?: unknown, status?: unknown },
    };
    if (typeof maybe.code === 'number') return maybe.code;
    if (typeof maybe.statusCode === 'number') return maybe.statusCode;
    if (typeof maybe.response?.statusCode === 'number') return maybe.response.statusCode;
    if (typeof maybe.response?.status === 'number') return maybe.response.status;
  }
  return undefined;
}

function getApiExceptionMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function decodeBase64Value(value: string, resourceName: string, key: string): string {
  try {
    return Buffer.from(value, 'base64').toString('utf-8');
  } catch (err) {
    throw new ResolutionError(`Failed to decode key "${key}" from Kubernetes Secret "${resourceName}"`, {
      tip: err instanceof Error ? err.message : String(err),
    });
  }
}

function decodeSecretData(resourceName: string, data?: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(data || {})) {
    result[key] = decodeBase64Value(value, resourceName, key);
  }
  return result;
}

function decodeConfigMapData(configMap: {
  data?: Record<string, string>,
  binaryData?: Record<string, string>,
}): Record<string, string> {
  const result: Record<string, string> = { ...(configMap.data || {}) };
  for (const [key, value] of Object.entries(configMap.binaryData || {})) {
    result[key] = Buffer.from(value, 'base64').toString('utf-8');
  }
  return result;
}

class KubernetesPluginInstance {
  private authConfig: KubernetesAuthConfig = {};
  private namespace = 'default';
  private clientPromise?: Promise<k8s.CoreV1Api>;

  constructor(
    readonly id: string,
  ) {}

  setAuth(config: KubernetesAuthConfig) {
    this.authConfig = config;
    debug(
      'kubernetes instance',
      this.id,
      'set auth - namespace:',
      config.namespace,
      'context:',
      config.context,
      'hasKubeconfig:',
      !!config.kubeconfig,
      'clusterServer:',
      config.clusterServer,
      'hasToken:',
      !!config.token,
      'allowMissing:',
      !!config.allowMissing,
    );
  }

  private async initKubeConfig(): Promise<k8s.KubeConfig> {
    const {
      namespace,
      context,
      kubeconfig,
      clusterServer,
      token,
      skipTlsVerify,
    } = this.authConfig;

    const kc = new k8s.KubeConfig();

    try {
      if (clusterServer) {
        kc.loadFromOptions({
          clusters: [
            {
              name: 'varlock-cluster',
              server: clusterServer,
              skipTLSVerify: skipTlsVerify ?? false,
            },
          ],
          users: [
            {
              name: 'varlock-user',
              ...(token ? { token } : {}),
            },
          ],
          contexts: [
            {
              name: 'varlock-context',
              cluster: 'varlock-cluster',
              user: 'varlock-user',
              namespace: namespace || 'default',
            },
          ],
          currentContext: 'varlock-context',
        });
      } else if (kubeconfig) {
        if (isRawKubeconfig(kubeconfig)) {
          kc.loadFromString(kubeconfig);
        } else {
          kc.loadFromFile(kubeconfig);
        }
      } else if (process.env.KUBERNETES_SERVICE_HOST && process.env.KUBERNETES_SERVICE_PORT) {
        kc.loadFromCluster();
      } else {
        kc.loadFromDefault();
      }

      if (context) {
        if (!kc.getContextObject(context)) {
          throw new SchemaError(`Kubernetes context "${context}" was not found`, {
            tip: 'Check `kubectl config get-contexts` or remove the context parameter to use the current context',
          });
        }
        kc.setCurrentContext(context);
      }

      const currentContext = kc.getContextObject(kc.getCurrentContext());
      this.namespace = namespace
        || currentContext?.namespace
        || await readServiceAccountNamespace()
        || 'default';

      return kc;
    } catch (err) {
      if (err instanceof SchemaError) throw err;
      throw new SchemaError(`Failed to initialize Kubernetes client: ${getApiExceptionMessage(err)}`, {
        tip: [
          'Verify your kubeconfig/current context is valid',
          'For local use, check `kubectl config current-context`',
          'For in-cluster use, check the pod service account token and RBAC permissions',
          'For explicit auth, provide clusterServer and token via @initKubernetes()',
        ].join('\n'),
      });
    }
  }

  private async initClient(): Promise<k8s.CoreV1Api> {
    if (this.clientPromise) return this.clientPromise;

    this.clientPromise = (async () => {
      const kc = await this.initKubeConfig();
      return kc.makeApiClient(k8s.CoreV1Api);
    })();

    return this.clientPromise;
  }

  private missingValue(): undefined {
    if (this.authConfig.allowMissing) return undefined;
    throw new Error('unreachable');
  }

  private handleReadError(err: unknown, kind: KubernetesObjectKind, resourceName: string): never | undefined {
    const status = getApiExceptionStatus(err);
    const location = `${kind} "${resourceName}" in namespace "${this.namespace}"`;

    if (status === 404) {
      if (this.authConfig.allowMissing) return this.missingValue();
      throw new ResolutionError(`${location} not found`, {
        tip: `Check the ${kind} name and namespace, or set allowMissing=true on @initKubernetes()`,
      });
    }

    if (status === 401) {
      throw new ResolutionError(`Authentication failed while reading Kubernetes ${location}`, {
        tip: 'Check your kubeconfig credentials, service account token, or explicit token',
      });
    }

    if (status === 403) {
      throw new ResolutionError(`Permission denied reading Kubernetes ${location}`, {
        tip: [
          'Grant the active user/service account read access:',
          '  apiGroups: [""]',
          `  resources: ["${kind === 'Secret' ? 'secrets' : 'configmaps'}"]`,
          '  verbs: ["get"]',
        ].join('\n'),
      });
    }

    throw new ResolutionError(`Failed to read Kubernetes ${location}: ${getApiExceptionMessage(err)}`);
  }

  private getMissingKey(
    kind: KubernetesObjectKind,
    resourceName: string,
    key: string,
    availableKeys: Array<string>,
  ): string | undefined {
    if (this.authConfig.allowMissing) return undefined;
    throw new ResolutionError(`Key "${key}" not found in Kubernetes ${kind} "${resourceName}"`, {
      tip: availableKeys.length
        ? `Available keys: ${availableKeys.join(', ')}`
        : `The ${kind} has no data keys`,
    });
  }

  async getSecretKey(secretName: string, key: string): Promise<string | undefined> {
    const client = await this.initClient();

    try {
      const secret = await client.readNamespacedSecret({
        name: secretName,
        namespace: this.namespace,
      });
      const data = decodeSecretData(secretName, secret.data);
      if (!(key in data)) return this.getMissingKey('Secret', secretName, key, Object.keys(data));
      return data[key];
    } catch (err) {
      if (err instanceof ResolutionError) throw err;
      return this.handleReadError(err, 'Secret', secretName);
    }
  }

  async getConfigMapKey(configMapName: string, key: string): Promise<string | undefined> {
    const client = await this.initClient();

    try {
      const configMap = await client.readNamespacedConfigMap({
        name: configMapName,
        namespace: this.namespace,
      });
      const data = decodeConfigMapData(configMap);
      if (!(key in data)) return this.getMissingKey('ConfigMap', configMapName, key, Object.keys(data));
      return data[key];
    } catch (err) {
      if (err instanceof ResolutionError) throw err;
      return this.handleReadError(err, 'ConfigMap', configMapName);
    }
  }

  async getSecretBulk(secretName: string): Promise<string> {
    const client = await this.initClient();

    try {
      const secret = await client.readNamespacedSecret({
        name: secretName,
        namespace: this.namespace,
      });
      return JSON.stringify(decodeSecretData(secretName, secret.data));
    } catch (err) {
      if (err instanceof ResolutionError) throw err;
      const maybeMissing = this.handleReadError(err, 'Secret', secretName);
      if (maybeMissing === undefined) return '{}';
      throw new Error('unreachable');
    }
  }

  async getConfigMapBulk(configMapName: string): Promise<string> {
    const client = await this.initClient();

    try {
      const configMap = await client.readNamespacedConfigMap({
        name: configMapName,
        namespace: this.namespace,
      });
      return JSON.stringify(decodeConfigMapData(configMap));
    } catch (err) {
      if (err instanceof ResolutionError) throw err;
      const maybeMissing = this.handleReadError(err, 'ConfigMap', configMapName);
      if (maybeMissing === undefined) return '{}';
      throw new Error('unreachable');
    }
  }
}

const pluginInstances: Record<string, KubernetesPluginInstance> = {};

function requirePluginInstances(resolverName: string) {
  if (Object.values(pluginInstances).length) return;
  throw new SchemaError('No Kubernetes plugin instances found', {
    tip: `Initialize at least one Kubernetes plugin instance using @initKubernetes() before using ${resolverName}()`,
  });
}

function getPluginInstance(instanceId: string, resolverName: string): KubernetesPluginInstance {
  requirePluginInstances(resolverName);

  const selectedInstance = pluginInstances[instanceId];
  if (selectedInstance) return selectedInstance;

  if (instanceId === '_default') {
    throw new SchemaError('Kubernetes plugin instance (without id) not found', {
      tip: [
        'Either remove the `id` param from your @initKubernetes call',
        `or use \`${resolverName}(id, ...)\` to select an instance by id`,
        `Available ids: ${Object.keys(pluginInstances).join(', ')}`,
      ].join('\n'),
    });
  }

  throw new SchemaError(`Kubernetes plugin instance id "${instanceId}" not found`, {
    tip: `Available ids: ${Object.keys(pluginInstances).join(', ')}`,
  });
}

async function resolveString(resolver: Resolver, label: string): Promise<string> {
  const resolved = await resolver.resolve();
  if (typeof resolved !== 'string') {
    throw new SchemaError(`Expected ${label} to resolve to a string`);
  }
  return resolved;
}

function inferItemKey(resolverCtx: any, resolverName: string): string {
  const parent = resolverCtx.parent;
  if (parent && typeof parent.key === 'string') return parent.key;
  throw new SchemaError(`When called without a key argument, ${resolverName}() must be used on a config item`, {
    tip: `Either provide a key argument or use ${resolverName}() on a config item`,
  });
}

function parseKeyResolverArgs(resolverCtx: any, resolverName: string) {
  let instanceId = '_default';
  let resourceNameResolver: Resolver;
  let keyResolver: Resolver | undefined;
  let inferredKey: string | undefined;

  const argCount = resolverCtx.arrArgs?.length ?? 0;
  if (argCount === 1) {
    resourceNameResolver = resolverCtx.arrArgs[0];
    inferredKey = inferItemKey(resolverCtx, resolverName);
  } else if (argCount === 2) {
    resourceNameResolver = resolverCtx.arrArgs[0];
    keyResolver = resolverCtx.arrArgs[1];
  } else if (argCount === 3) {
    if (!resolverCtx.arrArgs[0].isStatic) {
      throw new SchemaError('Expected instance id to be a static value');
    }
    instanceId = String(resolverCtx.arrArgs[0].staticValue);
    resourceNameResolver = resolverCtx.arrArgs[1];
    keyResolver = resolverCtx.arrArgs[2];
  } else {
    throw new SchemaError(`Expected ${resolverName}() to receive 1-3 arguments`);
  }

  getPluginInstance(instanceId, resolverName);

  return {
    instanceId,
    resourceNameResolver: resourceNameResolver!,
    keyResolver,
    inferredKey,
  };
}

function parseBulkResolverArgs(resolverCtx: any, resolverName: string) {
  let instanceId = '_default';
  let resourceNameResolver: Resolver;

  const argCount = resolverCtx.arrArgs?.length ?? 0;
  if (argCount === 1) {
    resourceNameResolver = resolverCtx.arrArgs[0];
  } else if (argCount === 2) {
    if (!resolverCtx.arrArgs[0].isStatic) {
      throw new SchemaError('Expected instance id to be a static value');
    }
    instanceId = String(resolverCtx.arrArgs[0].staticValue);
    resourceNameResolver = resolverCtx.arrArgs[1];
  } else {
    throw new SchemaError(`Expected ${resolverName}() to receive 1-2 arguments`);
  }

  getPluginInstance(instanceId, resolverName);

  return {
    instanceId,
    resourceNameResolver: resourceNameResolver!,
  };
}

plugin.registerRootDecorator({
  name: 'initKubernetes',
  description: 'Initialize a Kubernetes plugin instance for k8sSecret() and k8sConfigMap() resolvers',
  isFunction: true,
  async process(argsVal) {
    const objArgs = argsVal.objArgs;
    if (!objArgs) throw new SchemaError('Expected configuration arguments');

    if (objArgs.id && !objArgs.id.isStatic) {
      throw new SchemaError('Expected id to be static');
    }
    const id = String(objArgs?.id?.staticValue || '_default');
    if (pluginInstances[id]) {
      throw new SchemaError(`Instance with id "${id}" already initialized`);
    }

    pluginInstances[id] = new KubernetesPluginInstance(id);

    return {
      id,
      namespaceResolver: objArgs.namespace,
      contextResolver: objArgs.context,
      kubeconfigResolver: objArgs.kubeconfig,
      clusterServerResolver: objArgs.clusterServer,
      tokenResolver: objArgs.token,
      skipTlsVerifyResolver: objArgs.skipTlsVerify,
      allowMissingResolver: objArgs.allowMissing,
    };
  },
  async execute({
    id,
    namespaceResolver,
    contextResolver,
    kubeconfigResolver,
    clusterServerResolver,
    tokenResolver,
    skipTlsVerifyResolver,
    allowMissingResolver,
  }) {
    const namespace = asOptionalString(await namespaceResolver?.resolve());
    const context = asOptionalString(await contextResolver?.resolve());
    const kubeconfig = asOptionalString(await kubeconfigResolver?.resolve());
    const clusterServer = asOptionalString(await clusterServerResolver?.resolve());
    const token = asOptionalString(await tokenResolver?.resolve());
    const skipTlsVerify = asOptionalBoolean(await skipTlsVerifyResolver?.resolve(), 'skipTlsVerify');
    const allowMissing = asOptionalBoolean(await allowMissingResolver?.resolve(), 'allowMissing');

    pluginInstances[id].setAuth({
      namespace,
      context,
      kubeconfig,
      clusterServer,
      token,
      skipTlsVerify,
      allowMissing,
    });
  },
});

plugin.registerDataType({
  name: 'kubernetesBearerToken',
  sensitive: true,
  typeDescription: 'Kubernetes bearer token for API authentication',
  icon: KUBERNETES_ICON,
  docs: [
    {
      description: 'Kubernetes service account tokens',
      url: 'https://kubernetes.io/docs/reference/access-authn-authz/service-accounts-admin/',
    },
  ],
  async validate(val): Promise<true> {
    if (typeof val !== 'string' || val.trim().length === 0) {
      throw new ValidationError('Must be a non-empty bearer token');
    }
    return true;
  },
});

plugin.registerResolverFunction({
  name: 'k8sSecret',
  label: 'Fetch key from Kubernetes Secret',
  icon: KUBERNETES_ICON,
  argsSchema: {
    type: 'array',
    arrayMinLength: 1,
    arrayMaxLength: 3,
  },
  process() {
    return parseKeyResolverArgs(this, 'k8sSecret');
  },
  async resolve({
    instanceId, resourceNameResolver, keyResolver, inferredKey,
  }) {
    const resourceName = await resolveString(resourceNameResolver, 'Secret name');
    const key = keyResolver ? await resolveString(keyResolver, 'Secret key') : inferredKey;
    if (!key) throw new SchemaError('No Secret key provided');
    return pluginInstances[instanceId].getSecretKey(resourceName, key);
  },
});

plugin.registerResolverFunction({
  name: 'k8sConfigMap',
  label: 'Fetch key from Kubernetes ConfigMap',
  icon: KUBERNETES_ICON,
  argsSchema: {
    type: 'array',
    arrayMinLength: 1,
    arrayMaxLength: 3,
  },
  process() {
    return parseKeyResolverArgs(this, 'k8sConfigMap');
  },
  async resolve({
    instanceId, resourceNameResolver, keyResolver, inferredKey,
  }) {
    const resourceName = await resolveString(resourceNameResolver, 'ConfigMap name');
    const key = keyResolver ? await resolveString(keyResolver, 'ConfigMap key') : inferredKey;
    if (!key) throw new SchemaError('No ConfigMap key provided');
    return pluginInstances[instanceId].getConfigMapKey(resourceName, key);
  },
});

plugin.registerResolverFunction({
  name: 'k8sSecretBulk',
  label: 'Load all keys from Kubernetes Secret',
  icon: KUBERNETES_ICON,
  argsSchema: {
    type: 'array',
    arrayMinLength: 1,
    arrayMaxLength: 2,
  },
  process() {
    return parseBulkResolverArgs(this, 'k8sSecretBulk');
  },
  async resolve({ instanceId, resourceNameResolver }) {
    const resourceName = await resolveString(resourceNameResolver, 'Secret name');
    return pluginInstances[instanceId].getSecretBulk(resourceName);
  },
});

plugin.registerResolverFunction({
  name: 'k8sConfigMapBulk',
  label: 'Load all keys from Kubernetes ConfigMap',
  icon: KUBERNETES_ICON,
  argsSchema: {
    type: 'array',
    arrayMinLength: 1,
    arrayMaxLength: 2,
  },
  process() {
    return parseBulkResolverArgs(this, 'k8sConfigMapBulk');
  },
  async resolve({ instanceId, resourceNameResolver }) {
    const resourceName = await resolveString(resourceNameResolver, 'ConfigMap name');
    return pluginInstances[instanceId].getConfigMapBulk(resourceName);
  },
});
