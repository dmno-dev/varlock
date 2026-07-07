# @varlock/kubernetes-plugin

[![npm version](https://img.shields.io/npm/v/@varlock/kubernetes-plugin.svg)](https://npmx.dev/package/@varlock/kubernetes-plugin) [![GitHub stars](https://img.shields.io/github/stars/dmno-dev/varlock.svg?style=social&label=Star)](https://github.com/dmno-dev/varlock) [![license](https://img.shields.io/npm/l/@varlock/kubernetes-plugin.svg)](https://github.com/dmno-dev/varlock/blob/main/LICENSE)

Load values from Kubernetes [Secrets](https://kubernetes.io/docs/concepts/configuration/secret/) and [ConfigMaps](https://kubernetes.io/docs/concepts/configuration/configmap/) into your Varlock configuration.

## Scope

This plugin is **read-only**. It performs `get` requests on Secrets and ConfigMaps in a configured namespace and surfaces the values to your `.env` schema — nothing more. It does **not** create, update, or delete cluster resources, generate or template manifests, watch for changes, or manage deployments.

**Typical use cases:**
- **Local development** — pull dev/staging Secrets and ConfigMaps from a cluster into your local app without copying values by hand
- **In-cluster runtime** — read additional Secrets/ConfigMaps at runtime that aren't already mounted into the pod via `envFrom`/`valueFrom`
- **CI/CD** — read Secrets/ConfigMaps from a cluster using an explicit service account token

Deeper Kubernetes integration is on our radar. If you have ideas, a use case this plugin doesn't cover, or feedback from running it in production, come chat on [Discord](https://chat.dmno.dev) — we'd love to hear from you.

## Features

- Zero-config local development using your default kubeconfig
- In-cluster authentication using the pod's mounted service account
- Explicit auth via cluster API URL + bearer token (CI/CD, deployed apps)
- Fetch individual keys from Secrets and ConfigMaps
- Bulk-load whole Secrets or ConfigMaps with `@setValuesBulk`
- Configurable default Secret / ConfigMap so common cases don't repeat themselves
- Multiple plugin instances for different namespaces or clusters
- Auto-decode base64 Secret values and ConfigMap `binaryData`

## Installation

```bash
npm install @varlock/kubernetes-plugin
```

Then load it from your `.env.schema`:

```env-spec
# @plugin(@varlock/kubernetes-plugin)
```

## Setup + Auth

### Automatic auth (Recommended for local dev)

For local development, just initialize the plugin and it will use your default kubeconfig (`$KUBECONFIG` or `~/.kube/config`):

```env-spec
# @plugin(@varlock/kubernetes-plugin)
# @initKubernetes(namespace=default)
```

Inside a pod, omit kubeconfig-related settings and the plugin will use the mounted service account credentials at `/var/run/secrets/kubernetes.io/serviceaccount/`.

### Explicit cluster server + token (For CI/CD)

For deployments without a kubeconfig, provide the API server URL and a bearer token directly:

```env-spec
# @plugin(@varlock/kubernetes-plugin)
# @initKubernetes(
#   namespace=default,
#   clusterServer="https://kubernetes.example.com:6443",
#   token=$KUBERNETES_TOKEN
# )
# ---

# @type=kubernetesBearerToken @sensitive @internal
KUBERNETES_TOKEN=
```

See [Kubernetes Setup](#kubernetes-setup) below for how to mint a long-lived service account token.

### Raw kubeconfig

You can also pass a full kubeconfig as a string (YAML or JSON) — useful when injecting credentials from a secret manager:

```env-spec
# @initKubernetes(kubeconfig=$KUBECONFIG_DATA)
# ---
# @sensitive
KUBECONFIG_DATA=
```

### Authentication priority

The plugin tries authentication methods in this order:
1. **Explicit cluster server + token** — if `clusterServer` is provided
2. **Explicit kubeconfig** — if `kubeconfig` is provided (file path or raw YAML/JSON)
3. **In-cluster service account** — auto-detected via `KUBERNETES_SERVICE_HOST` / `KUBERNETES_SERVICE_PORT`
4. **Default kubeconfig** — `$KUBECONFIG` or `~/.kube/config`

You can override the active kubeconfig context with `context=...`.

### Multiple instances

To read from multiple namespaces or clusters, register named instances:

```env-spec
# @initKubernetes(id=dev, namespace=dev)
# @initKubernetes(id=prod, namespace=prod, context=prod-cluster)
# ---

DEV_DATABASE_URL=k8sSecret(dev, app-secrets, DATABASE_URL)
PROD_DATABASE_URL=k8sSecret(prod, app-secrets, DATABASE_URL)
```

## Reading values

### How Secrets and ConfigMaps are structured

A Kubernetes Secret/ConfigMap is a **named resource that holds a map of key/value pairs**:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: app-secrets       # ← the resource name
data:
  DATABASE_URL: cG9zdGdyZXM6...    # ← keys inside the resource
  API_KEY: c2VjcmV0LWtleQ==
```

So fetching a value is always a two-level lookup: which resource (`name`), and which key inside it (`key`).

### Secret keys

Secret `data` values are base64-decoded automatically.

```env-spec
# Auto-infer key from item name (fetches app-secrets.data.DATABASE_URL)
DATABASE_URL=k8sSecret(app-secrets)

# Explicit key name
DB_URL=k8sSecret(app-secrets, DATABASE_URL)

# Named args also work
DB_URL=k8sSecret(name=app-secrets, key=DATABASE_URL)
```

### ConfigMap keys

Both `data` (strings) and `binaryData` (base64-decoded) fields are supported.

```env-spec
PUBLIC_API_HOST=k8sConfigMap(app-config)
API_HOST=k8sConfigMap(app-config, PUBLIC_API_HOST)
```

### Default Secret / ConfigMap

The idiomatic k8s pattern is one Secret + one ConfigMap per app. Set defaults on the init decorator and skip the name argument:

```env-spec
# @plugin(@varlock/kubernetes-plugin)
# @initKubernetes(
#   namespace=default,
#   defaultSecret=app-secrets,
#   defaultConfigMap=app-config,
# )
# ---

# Both default to app-secrets / app-config and infer the key from the item name
DATABASE_URL=k8sSecret()
API_KEY=k8sSecret()
PUBLIC_API_HOST=k8sConfigMap()

# Override just the key while still using the default Secret
STRIPE_KEY=k8sSecret(key=stripe_api_key)

# Override the resource name to read from a different Secret
SHARED_TOKEN=k8sSecret(shared-secrets, AUTH_TOKEN)
```

You can mix positional and named arguments, but providing the same field both ways (e.g. `k8sSecret(app-secrets, name=other)`) is a schema error.

### Bulk loading

Use bulk loading when one Secret or ConfigMap contains several env vars. The bulk resolvers return a JSON object, which pairs with `@setValuesBulk`:

```env-spec
# @plugin(@varlock/kubernetes-plugin)
# @initKubernetes(namespace=default)
# @setValuesBulk(k8sSecretBulk(app-secrets), format=json)
# @setValuesBulk(k8sConfigMapBulk(app-config), format=json)
# ---

DATABASE_URL=
API_KEY=
PUBLIC_API_HOST=
```

Only items declared in your schema will be populated — extra keys in the resource are ignored. Bulk resolvers also pick up `defaultSecret` / `defaultConfigMap`, so the names can be omitted.

### Optional values

By default, fetching from a missing Secret/ConfigMap throws. To resolve missing resources or keys to `undefined`, set `allowMissing=true`:

```env-spec
# @initKubernetes(namespace=default, allowMissing=true)
# ---

# @required=false
OPTIONAL_FLAG=k8sConfigMap(feature-flags, NEW_UI)
```

Mark optional items with `@required=false` (or wrap with `fallback()`) so validation doesn't fail.

## Reference

### Root decorators

#### `@initKubernetes()`

Initialize a Kubernetes plugin instance for the resolvers below.

**Parameters:**

- `id?: string` (static) - Instance identifier for multiple instances (defaults to `_default`)
- `namespace?: string` - Kubernetes namespace. Defaults to the kubeconfig context namespace, the in-cluster service account namespace, or `default`
- `context?: string` - Kubeconfig context name (overrides the current context)
- `kubeconfig?: string` - Path to a kubeconfig file, or raw kubeconfig YAML/JSON content
- `clusterServer?: string` - Kubernetes API server URL for explicit auth (e.g., `https://kubernetes.example.com:6443`)
- `token?: string` - Bearer token for explicit auth
- `skipTlsVerify?: boolean` - Skip TLS verification (only applies to explicit `clusterServer` + `token` auth)
- `allowMissing?: boolean` - Missing resources or keys resolve to `undefined` instead of throwing
- `defaultSecret?: string` - Default Secret name for `k8sSecret()` / `k8sSecretBulk()`
- `defaultConfigMap?: string` - Default ConfigMap name for `k8sConfigMap()` / `k8sConfigMapBulk()`

### Functions

All resolvers accept positional and named arguments. The same field cannot be provided both ways.

#### `k8sSecret()`

Fetch a single key from a Secret. Values are base64-decoded automatically.

**Signatures:**

- `k8sSecret()` - Uses `defaultSecret`, infers key from item name
- `k8sSecret(name)` - Uses given Secret, infers key from item name
- `k8sSecret(name, key)` - Explicit name and key
- `k8sSecret(instanceId, name, key)` - With explicit instance
- `k8sSecret(name=..., key=..., id=...)` - Same with named args

#### `k8sConfigMap()`

Fetch a single key from a ConfigMap. Both `data` and `binaryData` are supported.

**Signatures:** same shape as `k8sSecret()` — substitute `k8sConfigMap` and `defaultConfigMap`.

#### `k8sSecretBulk()`

Fetch all keys from a Secret as a JSON object. Designed for `@setValuesBulk(..., format=json)`.

**Signatures:**

- `k8sSecretBulk()` - Uses `defaultSecret`
- `k8sSecretBulk(name)` - Explicit Secret name
- `k8sSecretBulk(instanceId, name)` - With explicit instance
- `k8sSecretBulk(name=..., id=...)` - Same with named args

#### `k8sConfigMapBulk()`

Same shape as `k8sSecretBulk()` — substitute `k8sConfigMapBulk` and `defaultConfigMap`.

### Data Types

- `kubernetesBearerToken` - Kubernetes service account / API server bearer token (sensitive)

---

## Kubernetes Setup

### Required RBAC permissions

The identity used by the plugin (your kubeconfig user, an in-cluster service account, or an explicit token) needs read access to Secrets and/or ConfigMaps in the target namespace.

The minimum permissions are `get` on `secrets` and `configmaps`:

```yaml
# varlock-rbac.yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: varlock-reader
  namespace: default
rules:
  - apiGroups: [""]
    resources: ["secrets", "configmaps"]
    verbs: ["get"]
```

```bash
kubectl apply -f varlock-rbac.yaml
```

For least privilege, omit `"secrets"` if you only need ConfigMaps. Prefer namespaced `Role`s over `ClusterRole`s whenever possible.

### Service account for in-cluster use

```bash
kubectl create serviceaccount varlock-reader -n default
```

Bind the role to the service account:

```yaml
# varlock-rolebinding.yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: varlock-reader-binding
  namespace: default
subjects:
  - kind: ServiceAccount
    name: varlock-reader
    namespace: default
roleRef:
  kind: Role
  name: varlock-reader
  apiGroup: rbac.authorization.k8s.io
```

Then use it in your pod spec:

```yaml
spec:
  serviceAccountName: varlock-reader
  containers:
    - name: app
      image: my-app:latest
```

### Generate a bearer token for explicit auth

For CI/CD or other external use cases, create a long-lived service account token:

```bash
kubectl apply -f - <<EOF
apiVersion: v1
kind: Secret
metadata:
  name: varlock-reader-token
  namespace: default
  annotations:
    kubernetes.io/service-account.name: varlock-reader
type: kubernetes.io/service-account-token
EOF

kubectl get secret varlock-reader-token -n default -o jsonpath='{.data.token}' | base64 -d
```

### Verify access

```bash
kubectl auth can-i get secrets -n default
kubectl auth can-i get configmaps -n default --as=system:serviceaccount:default:varlock-reader
```

## Troubleshooting

### Secret or ConfigMap not found (404)
- Verify the resource exists: `kubectl get secret <name> -n <namespace>`
- Double-check the namespace — the plugin only reads from the configured namespace
- Resource names are case-sensitive and namespace-scoped
- If the resource is genuinely optional, set `allowMissing=true` on `@initKubernetes()` and `@required=false` on the item

### Permission denied (403)
- Check that the active identity has the required RBAC: `kubectl auth can-i get secrets -n <namespace>`
- For in-cluster use, verify the pod's `serviceAccountName` is set and bound to a `Role`/`ClusterRole` that grants `get` on `secrets`/`configmaps`
- The error message includes the exact `Role` snippet you need to grant

### Authentication failed (401)
- **Local dev:** Run `kubectl config current-context` and `kubectl get secrets` to confirm your kubeconfig works
- **Explicit token:** Verify the token isn't expired or revoked
- **In-cluster:** Check the pod's mounted service account token at `/var/run/secrets/kubernetes.io/serviceaccount/token`

### Connection refused or TLS errors
- Verify the cluster API URL is reachable from your machine/pod
- For clusters with self-signed certificates and explicit auth, set `skipTlsVerify=true` (development only)
- If `kubectl` works but the plugin doesn't, your kubeconfig may rely on an exec credential plugin (`aws eks get-token`, `gke-gcloud-auth-plugin`, `kubelogin`) — ensure the helper binary is on your `$PATH`

### Wrong namespace
- The plugin uses (in order): explicit `namespace` argument, kubeconfig context namespace, pod's mounted SA namespace, or `default`
- Force a specific namespace with `@initKubernetes(namespace=my-ns)`
