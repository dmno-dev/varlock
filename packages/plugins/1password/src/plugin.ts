import { Resolver } from 'varlock/plugin-lib';

import { createDeferredPromise, DeferredPromise } from '@env-spec/utils/defer';
import { Client, createClient } from '@1password/sdk';
import { opCliRead } from './cli-helper';

const { ValidationError, SchemaError, ResolutionError } = plugin.ERRORS;

const PLUGIN_VERSION = plugin.version;
const OP_ICON = 'simple-icons:1password';

plugin.name = '1pass';
const { debug } = plugin;
debug('init - version =', plugin.version);
plugin.icon = OP_ICON;

class OpVaultInstance {
  private token?: string;
  private useCliAuth?: boolean;

  constructor(
    readonly id: string,
  ) {
  }

  setAuth(token: any, enableCliAuth: boolean) {
    if (token && typeof token === 'string') {
      this.token = token;
    }
    this.useCliAuth = !this.token && enableCliAuth;
    debug('1Password vault', this.id, ' set auth - ', token, enableCliAuth);
  }

  opClientPromise: Promise<Client> | undefined;
  async initSdkClient() {
    if (!this.token) return;
    if (this.opClientPromise) return;

    this.opClientPromise = createClient({
      auth: this.token,
      integrationName: 'varlock plugin',
      integrationVersion: PLUGIN_VERSION,
    });
  }

  readBatch?: Record<string, { defers: Array<DeferredPromise<string>> }> | undefined;

  async readItem(opReference: string) {
    if (this.useCliAuth) {
      // using op CLI
      // NOTE - cli helper does its own batching, untethered to a vault instance
      return await opCliRead(opReference);
    } else if (this.token) {
      await this.initSdkClient();
      // using JS SDK
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
    } else {
      throw new SchemaError('1Password vault not properly initialized - must provide token or enableCliAuth');
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
        commonErr = new ResolutionError(`1password SDK error - ${err}`);
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
const vaults: Record<string, OpVaultInstance> = {};


plugin.registerRootDecorator({
  name: 'initOpVault',
  description: 'Initialize a 1Password vault instance to use for @op decorator',
  isFunction: true,
  async process(argsVal) {
    const objArgs = argsVal.objArgs;
    if (!objArgs) throw new SchemaError('Expected some args');

    if (objArgs.id && !objArgs.id.isStatic) {
      throw new SchemaError('Expected id to be static');
    }
    const id = String(objArgs?.id?.staticValue || '_default');
    if (vaults[id]) {
      throw new SchemaError(`Vault with id "${id}" already initialized`);
    }
    vaults[id] = new OpVaultInstance(id);
    // TODO: validate more
    return {
      id,
      tokenResolver: objArgs.token,
      enableCliAuthResolver: objArgs.enableCliAuth,
    };
  },
  async execute({ id, tokenResolver, enableCliAuthResolver }) {
    const token = await tokenResolver.resolve();
    const enableCli = await enableCliAuthResolver?.resolve();
    vaults[id].setAuth(token, !!enableCli);
  },
});


plugin.registerDataType({
  name: 'op/serviceAccountToken',
  sensitive: true,
  typeDescription: 'Service account token used to authenticate with the [1Password CLI](https://developer.1password.com/docs/cli/get-started/) and [SDKs](https://developer.1password.com/docs/sdks/)',
  icon: OP_ICON,
  docs: [
    '1password service accounts',
    'https://developer.1password.com/docs/service-accounts/',
  ],
  async validate(val) {
    if (!val.startsWith('ops_')) {
      throw new ValidationError('Should start with ops_');
    }
  },
});

plugin.registerResolverFunction({
  name: 'op',
  label: 'Fetch value from 1Password',
  icon: OP_ICON,
  argsSchema: {
    type: 'array',
    arrayMinLength: 1,
  },
  process() {
    if (!this.arrArgs || !this.arrArgs.length) {
      throw new SchemaError('Expected 1 or 2 arguments');
    }

    let vaultId: string;
    let itemLocationResolver: Resolver;
    if (this.arrArgs.length === 1) {
      vaultId = '_default';
      itemLocationResolver = this.arrArgs[0];
    } else if (this.arrArgs.length === 2) {
      if (!(this.arrArgs[0].isStatic)) {
        throw new SchemaError('expected vault id to be a static value');
      } else {
        vaultId = String(this.arrArgs[0].staticValue);
      }
      itemLocationResolver = this.arrArgs[1];
    } else {
      throw new SchemaError('Expected 1 or 2 args');
    }

    // make sure vault id is valid
    const selectedVault = vaults[vaultId];
    if (!selectedVault) {
      throw new SchemaError(`Invalid vault id "${vaultId}"`);
    }

    return { vaultId, itemLocationResolver };
  },
  async resolve({ vaultId, itemLocationResolver }) {
    const selectedVault = vaults[vaultId];
    const opReference = await itemLocationResolver.resolve();
    if (typeof opReference !== 'string') {
      throw new SchemaError('expected op item location to resolve to a string');
    }
    const opValue = await selectedVault.readItem(opReference);
    return opValue;
  },
});
