import { Resolver } from 'varlock/plugin-lib';

import { createDeferredPromise, DeferredPromise } from '@env-spec/utils/defer';
import { Client, createClient } from '@1password/sdk';
import { opCliRead, opCliEnvironmentRead } from './cli-helper';

const { ValidationError, SchemaError, ResolutionError } = plugin.ERRORS;

const PLUGIN_VERSION = plugin.version;
const OP_ICON = 'simple-icons:1password';

plugin.name = '1pass';
const { debug } = plugin;
debug('init - version =', plugin.version);
plugin.icon = OP_ICON;

/** Parse env format output from `op environment read` into a flat {name: value} JSON string */
function parseOpEnvOutput(raw: string): string {
  const result: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const eqPos = line.indexOf('=');
    if (eqPos === -1) continue;
    const key = line.substring(0, eqPos).trim();
    if (!key) continue;
    result[key] = line.substring(eqPos + 1);
  }
  return JSON.stringify(result);
}

class OpPluginInstance {
  /** 1Password service account token */
  private token?: string;
  /** optional - account shorthand or id to limit access */
  private account?: string;
  /**
   * if true, will try to use 1Pass app auth (via `op` CLI)
   * (will not be set to true if a token is provided)
   * */
  private allowAppAuth?: boolean;

  constructor(
    readonly id: string,
  ) {
  }

  setAuth(token: any, allowAppAuth: boolean, account?: string) {
    if (token && typeof token === 'string') this.token = token;
    this.allowAppAuth = allowAppAuth;
    this.account = account;
    debug('op instance', this.id, ' set auth - ', token, allowAppAuth, account);
  }

  opClientPromise: Promise<Client> | undefined;
  async initSdkClient() {
    if (!this.token) return;
    if (this.opClientPromise) return;

    // TODO: pass through account once SDK allows it
    this.opClientPromise = createClient({
      auth: this.token,
      integrationName: 'varlock plugin',
      integrationVersion: PLUGIN_VERSION,
    });
  }

  readBatch?: Record<string, { defers: Array<DeferredPromise<string>> }> | undefined;

  async readItem(opReference: string) {
    if (this.token) {
      // using JS SDK client using service account token
      await this.initSdkClient();
      if (this.opClientPromise) {
        // simple batching setup, so we can use bulk read sdk method
        let triggerBatch = false;
        if (!this.readBatch) {
          this.readBatch = {};
          triggerBatch = true;
        }
        // add item to batch, with deferred promise
        this.readBatch[opReference] = { defers: [] };
        const deferred = createDeferredPromise();
        this.readBatch[opReference].defers.push(deferred);
        if (triggerBatch) {
          setImmediate(() => this.executeReadBatch());
        }
        return deferred.promise;
      }
    } else if (this.allowAppAuth) {
      // using op CLI to talk to 1Password desktop app
      // NOTE - cli helper does its own batching, untethered to a specific op instance
      return await opCliRead(opReference, this.account);
    } else {
      throw new SchemaError('Unable to authenticate with 1Password', {
        tip: `Plugin instance (${this.id}) must be provided either a service account token or have app auth enabled (allowAppAuth=true)`,
      });
    }
  }

  async readEnvironment(environmentId: string): Promise<string> {
    if (this.token) {
      // Use SDK - supports environments since v0.4.1-beta.1
      await this.initSdkClient();
      const opClient = await this.opClientPromise;
      if (!opClient) throw new Error('Expected op sdk to be initialized');
      const response = await opClient.environments.getVariables(environmentId);
      // Convert EnvironmentVariable[] to flat {name: value} JSON string
      const result: Record<string, string> = {};
      for (const v of response.variables) {
        result[v.name] = v.value;
      }
      return JSON.stringify(result);
    } else if (this.allowAppAuth) {
      // Use CLI for desktop app auth
      const cliResult = await opCliEnvironmentRead(environmentId, this.account);
      // CLI outputs env format (KEY=value lines) - parse to flat JSON
      return parseOpEnvOutput(cliResult);
    } else {
      throw new SchemaError('Unable to authenticate with 1Password', {
        tip: `Plugin instance (${this.id}) must be provided either a service account token or have app auth enabled (allowAppAuth=true)`,
      });
    }
  }

  private async executeReadBatch() {
    const opClient = await this.opClientPromise;
    if (!opClient) throw new Error('Expected op sdk to be initialized');

    const batch = this.readBatch;
    this.readBatch = undefined;

    const opReferences = Object.keys(batch || {});
    debug('bulk fetching', opReferences);
    if (!opReferences.length) return;

    try {
      const result = await opClient.secrets.resolveAll(opReferences);

      for (const ref in batch) {
        for (const dp of batch[ref].defers) {
          const itemResponse = result.individualResponses[ref];
          if (itemResponse.error) {
            dp.reject(new ResolutionError(`1Password error - ${itemResponse.error.message || itemResponse.error.type}`));
          } else if (itemResponse.content) {
            dp.resolve(itemResponse.content.secret);
          } else {
            dp.reject(new ResolutionError('bulk fetch is missing item response'));
          }
        }
      }
    } catch (err) {
      let commonErr;
      // 1pass sdk throws strings as errors...
      if (typeof err === 'string') {
        commonErr = new ResolutionError(`1Password SDK error - ${err}`);
      } else {
        commonErr = err as Error;
      }

      for (const ref in batch) {
        for (const dp of batch[ref].defers) {
          const wrappedErr = new Error(`1Password error - ${commonErr.message}`);
          wrappedErr.cause = commonErr;
          dp.reject(err);
        }
      }
    }
  }
}
const pluginInstances: Record<string, OpPluginInstance> = {};

plugin.registerRootDecorator({
  name: 'initOp',
  description: 'Initialize a 1Password plugin instance for op() resolver',
  isFunction: true,
  async process(argsVal) {
    const objArgs = argsVal.objArgs;
    if (!objArgs) throw new SchemaError('Expected some args');

    if (objArgs.id && !objArgs.id.isStatic) {
      throw new SchemaError('Expected id to be static');
    }
    const id = String(objArgs?.id?.staticValue || '_default');
    if (pluginInstances[id]) {
      throw new SchemaError(`Instance with id "${id}" already initialized`);
    }
    pluginInstances[id] = new OpPluginInstance(id);
    // TODO: validate more

    if (objArgs.account && !objArgs.account.isStatic) {
      throw new SchemaError('Expected account to be static');
    }
    const account = objArgs?.account ? String(objArgs?.account?.staticValue) : undefined;

    // user should either be setting token, allowAppAuth, or both
    // we will check again later with resovled values
    if (!objArgs.token && !objArgs.allowAppAuth) {
      throw new SchemaError('Either token or allowAppAuth must be set');
    }

    return {
      id,
      account,
      tokenResolver: objArgs.token,
      allowAppAuthResolver: objArgs.allowAppAuth,
    };
  },
  async execute({
    id, account, tokenResolver, allowAppAuthResolver,
  }) {
    // even if these are empty, we can't throw errors yet
    // in case the instance is never actually used
    const token = await tokenResolver?.resolve();
    const enableAppAuth = await allowAppAuthResolver?.resolve();
    pluginInstances[id].setAuth(token, !!enableAppAuth, account);
  },
});


plugin.registerDataType({
  name: 'opServiceAccountToken',
  sensitive: true,
  typeDescription: 'Service account token used to authenticate with the [1Password CLI](https://developer.1password.com/docs/cli/get-started/) and [SDKs](https://developer.1password.com/docs/sdks/)',
  icon: OP_ICON,
  docs: [
    {
      description: '1Password service accounts',
      url: 'https://developer.1password.com/docs/service-accounts/',
    },
    'https://example.com',
  ],
  async validate(val) {
    if (!val.startsWith('ops_')) {
      throw new ValidationError('Service account tokens must start with ops_');
    }
  },
});

plugin.registerResolverFunction({
  name: 'op',
  label: 'Fetch single field value from 1Password',
  icon: OP_ICON,
  argsSchema: {
    type: 'array',
    arrayMinLength: 1,
  },
  process() {
    if (!this.arrArgs || !this.arrArgs.length) {
      throw new SchemaError('Expected 1 or 2 arguments');
    }

    let instanceId: string;
    let itemLocationResolver: Resolver;
    if (this.arrArgs.length === 1) {
      instanceId = '_default';
      itemLocationResolver = this.arrArgs[0];
    } else if (this.arrArgs.length === 2) {
      if (!(this.arrArgs[0].isStatic)) {
        throw new SchemaError('expected instance id to be a static value');
      } else {
        instanceId = String(this.arrArgs[0].staticValue);
      }
      itemLocationResolver = this.arrArgs[1];
    } else {
      throw new SchemaError('Expected 1 or 2 args');
    }

    if (!Object.values(pluginInstances).length) {
      throw new SchemaError('No 1Password plugin instances found', {
        tip: 'Initialize at least one 1Password plugin instance using the @initOp root decorator',
      });
    }

    // make sure instance id is valid
    const selectedInstance = pluginInstances[instanceId];
    if (!selectedInstance) {
      if (instanceId === '_default') {
        throw new SchemaError('1Password plugin instance (without id) not found', {
          tip: [
            'Either remove the `id` param from your @initOp call',
            'or use `op(id, reference)` to select an instance by id.',
            `Possible ids are: ${Object.keys(pluginInstances).join(', ')}`,
          ].join('\n'),
        });
      } else {
        throw new SchemaError(`1Password plugin instance id "${instanceId}" not found`, {
          tip: [`Valid ids are: ${Object.keys(pluginInstances).join(', ')}`].join('\n'),
        });
      }
    }

    return { instanceId, itemLocationResolver };
  },
  async resolve({ instanceId, itemLocationResolver }) {
    const selectedInstance = pluginInstances[instanceId];
    const opReference = await itemLocationResolver.resolve();
    if (typeof opReference !== 'string') {
      throw new SchemaError('expected op item location to resolve to a string');
    }
    const opValue = await selectedInstance.readItem(opReference);
    return opValue;
  },
});

plugin.registerResolverFunction({
  name: 'opLoadEnvironment',
  label: 'Load all variables from a 1Password environment',
  icon: OP_ICON,
  argsSchema: {
    type: 'array',
    arrayMinLength: 1,
    arrayMaxLength: 2,
  },
  process() {
    if (!this.arrArgs || !this.arrArgs.length) {
      throw new SchemaError('Expected 1 or 2 arguments');
    }

    let instanceId: string;
    let environmentIdResolver: Resolver;

    if (this.arrArgs.length === 1) {
      instanceId = '_default';
      environmentIdResolver = this.arrArgs[0];
    } else if (this.arrArgs.length === 2) {
      if (!this.arrArgs[0].isStatic) {
        throw new SchemaError('expected instance id to be a static value');
      }
      instanceId = String(this.arrArgs[0].staticValue);
      environmentIdResolver = this.arrArgs[1];
    } else {
      throw new SchemaError('Expected 1 or 2 args');
    }

    if (!Object.values(pluginInstances).length) {
      throw new SchemaError('No 1Password plugin instances found', {
        tip: 'Initialize at least one 1Password plugin instance using the @initOp root decorator',
      });
    }

    const selectedInstance = pluginInstances[instanceId];
    if (!selectedInstance) {
      if (instanceId === '_default') {
        throw new SchemaError('1Password plugin instance (without id) not found', {
          tip: [
            'Either remove the `id` param from your @initOp call',
            'or use `opLoadEnvironment(id, environmentId)` to select an instance by id.',
            `Possible ids are: ${Object.keys(pluginInstances).join(', ')}`,
          ].join('\n'),
        });
      } else {
        throw new SchemaError(`1Password plugin instance id "${instanceId}" not found`, {
          tip: [`Valid ids are: ${Object.keys(pluginInstances).join(', ')}`].join('\n'),
        });
      }
    }

    return { instanceId, environmentIdResolver };
  },
  async resolve({ instanceId, environmentIdResolver }) {
    const selectedInstance = pluginInstances[instanceId];
    const environmentId = await environmentIdResolver.resolve();
    if (typeof environmentId !== 'string') {
      throw new SchemaError('expected environment ID to resolve to a string');
    }
    return await selectedInstance.readEnvironment(environmentId);
  },
});
