import type { VarlockPluginDef, Resolver } from 'varlock/plugin-lib';

import { createDeferredPromise, DeferredPromise } from '@env-spec/utils/defer';
import { Client, createClient } from '@1password/sdk';

import { opCliRead } from './cli-helper';

class ResolutionError extends Error {}
class ValidationError extends Error {}
class SchemaError extends Error {}

const PLUGIN_VERSION = '0.0.1';

class OpVaultInstance {
  constructor(readonly id: string, readonly tokenVarName: string) {
  }

  opClientPromise: Promise<Client> | undefined;
  async initSdkClient(serviceAccountToken: string) {
    if (!serviceAccountToken) return;
    if (this.opClientPromise) return;

    this.opClientPromise = createClient({
      auth: serviceAccountToken,
      integrationName: 'varlock plugin',
      integrationVersion: PLUGIN_VERSION,
    });
  }

  readBatch?: Record<string, { defers: Array<DeferredPromise<string>> }> | undefined;

  async readItem(opReference: string) {
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

    // using op CLI
    // NOTE - cli helper does its own batching, untethered to a vault instance
    return await opCliRead(opReference);
  }

  private async executeReadBatch() {
    const opClient = await this.opClientPromise;
    if (!opClient) throw new Error('Expected op sdk to be initialized');

    const batch = this.readBatch;
    this.readBatch = undefined;

    const opReferences = Object.keys(batch || {});
    console.log('bulk fetching', opReferences);
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

const OP_ICON = 'simple-icons:1password';

export const plugin: VarlockPluginDef = {
  name: '1password',
  version: PLUGIN_VERSION,
  description: 'pull data from 1password',
  icon: OP_ICON,

  rootDecorators: [
    {
      name: 'initOpVault',
      isFunction: true,
      async process(ctx) {
        const fnArgs = ctx.dec.bareFnArgs;
        const argsObj = (fnArgs?.simplifiedValues as any);

        const id = argsObj.id || '_default';
        // name of env var which holds service account token
        const tokenVarName = argsObj.token;

        vaults[id] = new OpVaultInstance(id, tokenVarName);
      },
    },
  ],
  // itemDecorators: {
  //   pluginItemDec: {},
  // },
  dataTypes: [
    {
      name: 'op/serviceAccountToken',
      sensitive: true,
      typeDescription: 'Service account token used to authenticate with the [1Password CLI](https://developer.1password.com/docs/cli/get-started/) and [SDKs](https://developer.1password.com/docs/sdks/)',
      docs: [
        '1password service accounts',
        'https://developer.1password.com/docs/service-accounts/',
      ],
      async validate(val) {
        if (!val.startsWith('ops_')) {
          throw new ValidationError('Should start with ops_');
        }
      },
    },
  ],
  resolverFunctions: [
    {
      name: 'op',
      label: 'Fetch value from 1Password',
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

        // add dependency on env var which contains encrpytion key
        if (selectedVault.tokenVarName) {
          this.addDep(selectedVault.tokenVarName);
        }

        return { vaultId, itemLocationResolver };
      },
      async resolve({ vaultId, itemLocationResolver }) {
        const selectedVault = vaults[vaultId];

        if (selectedVault.tokenVarName) {
          const serviceAccountToken = this.getDepValue(selectedVault.tokenVarName);
          if (serviceAccountToken !== undefined) {
            if (typeof serviceAccountToken !== 'string') {
              throw new ResolutionError(`Expected ${selectedVault.tokenVarName} to be a string`);
            }
            await selectedVault.initSdkClient(serviceAccountToken);
          }
        }

        const opReference = await itemLocationResolver.resolve();
        const opValue = await selectedVault.readItem(opReference);
        return opValue;
      },
    },
  ],
};
