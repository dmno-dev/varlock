# @varlock/kubernetes-plugin

Load values from Kubernetes [Secrets](https://kubernetes.io/docs/concepts/configuration/secret/) and [ConfigMaps](https://kubernetes.io/docs/concepts/configuration/configmap/) into your Varlock configuration.

## Features

- Fetch individual keys from Kubernetes Secrets and ConfigMaps
- Bulk-load whole Secrets or ConfigMaps with `@setValuesBulk`
- Local kubeconfig, in-cluster service account, or explicit API server/token auth
- Multiple plugin instances for different namespaces or clusters
- Auto-infer Secret/ConfigMap keys from Varlock item names
- Read-only behavior; the plugin does not write to the cluster

## Installation

```bash
npm install @varlock/kubernetes-plugin
```

Then load it from your `.env.schema`:

```env-spec
# @plugin(@varlock/kubernetes-plugin)
```

## Setup

For local development, the plugin uses your default kubeconfig unless configured otherwise:

```env-spec
# @plugin(@varlock/kubernetes-plugin)
# @initKubernetes(namespace=default)
# ---
```

Inside a pod, omit kubeconfig settings and the plugin will use the in-cluster service account.

For explicit API server authentication:

```env-spec
# @plugin(@varlock/kubernetes-plugin)
# @initKubernetes(
#   namespace=default,
#   clusterServer="https://kubernetes.default.svc",
#   token=$KUBERNETES_TOKEN
# )
# ---
# @type=kubernetesBearerToken @sensitive
KUBERNETES_TOKEN=
```

## Usage

### Secret keys

```env-spec
# The key defaults to the Varlock config item name
DATABASE_URL=k8sSecret(app-secrets)

# Or provide the key explicitly
DB_URL=k8sSecret(app-secrets, DATABASE_URL)
```

Kubernetes Secret values are base64-decoded before being returned.

### ConfigMap keys

```env-spec
PUBLIC_API_HOST=k8sConfigMap(app-config)
API_HOST=k8sConfigMap(app-config, PUBLIC_API_HOST)
```

### Multiple instances

```env-spec
# @initKubernetes(id=dev, namespace=dev)
# @initKubernetes(id=prod, namespace=prod, context=prod)
# ---

DEV_DATABASE_URL=k8sSecret(dev, app-secrets, DATABASE_URL)
PROD_DATABASE_URL=k8sSecret(prod, app-secrets, DATABASE_URL)
```

### Bulk loading

```env-spec
# @plugin(@varlock/kubernetes-plugin)
# @initKubernetes(namespace=default)
# @setValuesBulk(k8sSecretBulk(app-secrets), format=json)
# @setValuesBulk(k8sConfigMapBulk(app-config), format=json)
# ---

DATABASE_URL=
PUBLIC_API_HOST=
```

## `@initKubernetes()` options

- `id` optional static instance id, defaults to `_default`
- `namespace` optional namespace, defaults to kubeconfig context namespace or `default`
- `context` optional kubeconfig context name
- `kubeconfig` optional path to kubeconfig file, or raw kubeconfig YAML/JSON
- `clusterServer` optional Kubernetes API server URL for explicit auth
- `token` optional bearer token for explicit auth
- `skipTlsVerify` optional boolean for explicit auth only
- `allowMissing` optional boolean; missing resources or keys return `undefined` instead of throwing

## Resolver functions

- `k8sSecret(secretName)`
- `k8sSecret(secretName, key)`
- `k8sSecret(instanceId, secretName, key)`
- `k8sConfigMap(configMapName)`
- `k8sConfigMap(configMapName, key)`
- `k8sConfigMap(instanceId, configMapName, key)`
- `k8sSecretBulk(secretName)`
- `k8sSecretBulk(instanceId, secretName)`
- `k8sConfigMapBulk(configMapName)`
- `k8sConfigMapBulk(instanceId, configMapName)`
