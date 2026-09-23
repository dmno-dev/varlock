import {
  type Resolver, type PluginCacheAccessor, plugin, resolveCacheTtl,
} from 'varlock/plugin-lib';
import { createHash } from 'node:crypto';

const { SchemaError, ResolutionError } = plugin.ERRORS;

const PENV_ICON = 'mdi:shield-key-outline';
const DEFAULT_URL = 'https://penv.cloud';
const TIMEOUT_MS = 15_000;

plugin.name = 'penv';
const { debug } = plugin;
// Read while the plugin context is active; it is gone by the time values resolve.
const VERSION = plugin.version;
debug('init - version =', VERSION);
let pluginCache: PluginCacheAccessor | undefined;
try {
  pluginCache = plugin.cache;
} catch {
  // cache unavailable in this runtime context
}
plugin.icon = PENV_ICON;
plugin.standardVars = {
  initDecorator: '@initPenv',
  params: {
    token: { key: 'PENV_TOKEN', dataType: 'penvToken' },
  },
};

type Address = { org: string, project: string, environment: string, key: string };

/** `org/project` from `@penv=`, the same header the penv CLI reads. */
let header: { org: string, project: string } | undefined;

/** penv.cloud answers GET /api/v1/envs/{org}/{project}/{environment} with every key. */
type EnvBody = {
  keys: Array<{ path?: string, name: string, value?: string }>,
  skipped?: Array<string>,
};

/** https everywhere but loopback, and no user info in front of the host. */
function checkedUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SchemaError(`penv url "${raw}" is not a URL`);
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new SchemaError(`penv url must be https (http only for localhost): ${url.origin}`);
  }
  if (url.username || url.password) {
    throw new SchemaError('penv url must not carry a user name or password');
  }
  return url.origin + url.pathname.replace(/\/+$/, '');
}

class PenvInstance {
  environment = 'development';
  url = DEFAULT_URL;
  cacheTtl?: string | number;
  private token?: string;
  private org?: string;
  private project?: string;
  private reads: Record<string, Promise<Record<string, string | undefined>>> = {};

  set(opts: { environment?: unknown, url?: unknown, token?: unknown, org?: unknown, project?: unknown }) {
    if (typeof opts.environment === 'string' && opts.environment) this.environment = opts.environment;
    if (typeof opts.url === 'string' && opts.url) this.url = checkedUrl(opts.url);
    if (typeof opts.token === 'string' && opts.token) this.token = opts.token;
    if (typeof opts.org === 'string' && opts.org) this.org = opts.org;
    if (typeof opts.project === 'string' && opts.project) this.project = opts.project;
  }

  /** `KEY`, `env/KEY`, `project/env/KEY` or `org/project/env/KEY`, as the penv CLI reads them. */
  address(written: string): Address {
    const parts = written.split('/').map((p) => p.trim());
    if (parts.some((p) => !p) || parts.length > 4) {
      throw new SchemaError(`penv(${written}) is not an address`, {
        tip: 'Write penv(), penv(KEY), penv(env/KEY), penv(project/env/KEY) or penv(org/project/env/KEY)',
      });
    }
    const org = this.org ?? header?.org;
    const project = this.project ?? header?.project;
    const key = parts[parts.length - 1];
    if (parts.length === 4) {
      return {
        org: parts[0], project: parts[1], environment: parts[2], key,
      };
    }
    if (!org || !project) {
      throw new SchemaError(`penv(${written}) needs a project`, {
        tip: 'Add # @penv=org/project to the header, or pass org and project to @initPenv()',
      });
    }
    if (parts.length === 3) {
      return {
        org, project: parts[0], environment: parts[1], key,
      };
    }
    if (parts.length === 2) {
      return {
        org, project, environment: parts[0], key,
      };
    }
    return {
      org, project, environment: this.environment, key,
    };
  }

  /** Short hash naming the token, so a cache is never shared between credentials. */
  scope(at: Address) {
    const who = createHash('sha256').update(this.token ?? '').digest('hex').slice(0, 12);
    return `${who}:${this.url}:${at.org}/${at.project}/${at.environment}`;
  }

  /** One request per environment per load, shared by every key that reads it. */
  environmentValues(at: Address): Promise<Record<string, string | undefined>> {
    const label = `${at.org}/${at.project}/${at.environment}`;
    this.reads[label] ??= this.fetchEnvironment(at).catch((err) => {
      delete this.reads[label];
      throw err;
    });
    return this.reads[label];
  }

  private async fetchEnvironment(at: Address): Promise<Record<string, string | undefined>> {
    if (!this.token) {
      throw new SchemaError('penv token is required', {
        tip: 'Set PENV_TOKEN, or pass token= to @initPenv()',
      });
    }
    const label = `${at.org}/${at.project}/${at.environment}`;
    const path = [at.org, at.project, at.environment].map(encodeURIComponent).join('/');
    let response: Response;
    try {
      response = await fetch(`${this.url}/api/v1/envs/${path}`, {
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: 'application/json',
          'user-agent': `varlock-penv-plugin/${VERSION}`,
        },
        // A redirect could carry the token to another host.
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err: any) {
      throw new ResolutionError(`penv.cloud could not be reached for ${label}: ${err?.name === 'TimeoutError' ? 'timed out' : 'network error'}`, {
        tip: `Check the network, and that ${this.url} is the right url`,
      });
    }
    if (response.status === 401) {
      throw new ResolutionError(`penv.cloud rejected the token for ${label}`, {
        tip: 'Create a machine token in the penv.cloud console and set PENV_TOKEN',
      });
    }
    if (response.status === 403) {
      throw new ResolutionError(`the token may not read ${label}`, {
        tip: 'Give the machine identity this project and environment in the penv.cloud console',
      });
    }
    if (response.status === 404) {
      throw new ResolutionError(`${label} does not exist on penv.cloud`, {
        tip: 'Check the org, project and environment names; `penv project ls` lists them',
      });
    }
    if (!response.ok) {
      throw new ResolutionError(`penv.cloud answered ${response.status} for ${label}`);
    }
    const body = await response.json() as EnvBody;
    const values: Record<string, string | undefined> = {};
    for (const key of body.keys ?? []) {
      if (!key.path) values[key.name] = key.value;
    }
    debug(`read ${Object.keys(values).length} keys from ${label}`);
    return values;
  }

  async value(at: Address): Promise<string> {
    const label = `${at.org}/${at.project}/${at.environment}`;
    const read = () => this.environmentValues(at);
    const values = this.cacheTtl !== undefined && pluginCache
      ? await pluginCache.getOrSet(`penv:${this.scope(at)}`, this.cacheTtl, read) as Record<string, string | undefined>
      : await read();
    if (!(at.key in values)) {
      throw new ResolutionError(`${at.key} is not in ${label}`, {
        tip: `Add it with: penv set ${at.key} --env ${at.environment}`,
      });
    }
    const value = values[at.key];
    if (value === undefined) {
      throw new ResolutionError(`${at.key} has no stored value in ${label}`, {
        tip: `Set one with: penv set ${at.key} --env ${at.environment}`,
      });
    }
    return value;
  }

  async all(environment: string): Promise<Record<string, string>> {
    const at = this.address(`${environment}/_`);
    const values = await this.environmentValues(at);
    return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined)) as Record<string, string>;
  }
}

const instance = new PenvInstance();
let initialised = false;

// The same header the penv CLI reads, so one .env.schema serves both tools.
plugin.registerRootDecorator({
  name: 'penv',
  description: 'The penv.cloud org and project this schema reads: org/project',
  process(decVal) {
    if (!decVal.isStatic || typeof decVal.staticValue !== 'string') {
      throw new SchemaError('@penv= takes a static org/project');
    }
    let value = decVal.staticValue.trim();
    const colon = value.indexOf(':');
    if (colon !== -1) {
      const provider = value.slice(0, colon);
      if (provider !== 'penv') {
        throw new SchemaError(`@penv=${value} names provider "${provider}"; this plugin reads penv.cloud only`);
      }
      value = value.slice(colon + 1);
    }
    const [org, project, ...rest] = value.split('/');
    if (!org || !project || rest.length) {
      throw new SchemaError(`@penv=${value} is not org/project`);
    }
    header = { org, project };
    return {};
  },
});

plugin.registerRootDecorator({
  name: 'initPenv',
  description: 'Configure penv.cloud access for penv() and penvBulk()',
  isFunction: true,
  async process(argsVal) {
    if (initialised) throw new SchemaError('@initPenv() is already set');
    initialised = true;
    const objArgs = argsVal.objArgs ?? {};
    return {
      environmentResolver: objArgs.environment,
      tokenResolver: objArgs.token,
      urlResolver: objArgs.url,
      orgResolver: objArgs.org,
      projectResolver: objArgs.project,
      cacheTtlResolver: objArgs.cacheTtl,
    };
  },
  async execute({
    environmentResolver, tokenResolver, urlResolver, orgResolver, projectResolver, cacheTtlResolver,
  }) {
    // Unresolved values are not errors yet: an instance nobody reads needs none.
    instance.set({
      environment: await environmentResolver?.resolve(),
      token: await tokenResolver?.resolve(),
      url: await urlResolver?.resolve(),
      org: await orgResolver?.resolve(),
      project: await projectResolver?.resolve(),
    });
    const cacheTtl = await resolveCacheTtl(cacheTtlResolver);
    if (cacheTtl !== undefined) instance.cacheTtl = cacheTtl;
  },
});

plugin.registerDataType({
  name: 'penvToken',
  sensitive: true,
  internal: true,
  typeDescription: 'penv.cloud machine token (pck_...)',
  icon: PENV_ICON,
  docs: [{ description: 'penv.cloud machine tokens', url: 'https://github.com/penvhq/penvhq/blob/main/docs/Cloud-API.md' }],
});

plugin.registerResolverFunction({
  name: 'penv',
  label: 'Read a value from penv.cloud',
  icon: PENV_ICON,
  argsSchema: { type: 'array', arrayMinLength: 0, arrayMaxLength: 1 },
  process() {
    let written: Resolver | undefined;
    let itemKey: string | undefined;
    if (this.arrArgs?.length) {
      written = this.arrArgs[0];
    } else {
      const parent = (this as any).parent;
      if (!parent || typeof parent.key !== 'string') {
        throw new SchemaError('penv() with no argument reads the key it is on, so it must be on a config item');
      }
      itemKey = parent.key;
    }
    return { written, itemKey };
  },
  async resolve({ written, itemKey }) {
    const address = written ? await written.resolve() : itemKey;
    if (typeof address !== 'string') throw new SchemaError('penv() takes an address written as text');
    return instance.value(instance.address(address));
  },
});

plugin.registerResolverFunction({
  name: 'penvBulk',
  label: 'Load every value of a penv.cloud environment',
  icon: PENV_ICON,
  argsSchema: { type: 'array', arrayMaxLength: 1 },
  process() {
    return { environment: this.arrArgs?.[0] };
  },
  async resolve({ environment }) {
    const name = environment ? await environment.resolve() : instance.environment;
    if (typeof name !== 'string') throw new SchemaError('penvBulk() takes an environment name');
    return JSON.stringify(await instance.all(name));
  },
});

plugin.registerTelemetryAttributes(() => ({
  instance_count: initialised ? 1 : 0,
  cache_enabled: instance.cacheTtl != null,
}));
