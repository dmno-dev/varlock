import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { Resolver } from 'varlock/plugin-lib';

import { createDeferredPromise, DeferredPromise } from '@env-spec/utils/defer';

const execAsync = promisify(exec);

const { ValidationError, SchemaError, ResolutionError } = plugin.ERRORS;

const KEYCHAIN_ICON = 'game-icons:keyring';

plugin.name = 'keychain';
const { debug } = plugin;
debug('init - version =', plugin.version);
plugin.icon = KEYCHAIN_ICON;

// class OpPluginInstance {
//   /** 1Password service account token */
//   private token?: string;
//   /** optional - account shorthand or id to limit access */
//   private account?: string;
//   /**
//    * if true, will try to use 1Pass app auth (via `op` CLI)
//    * (will not be set to true if a token is provided)
//    * */
//   private allowAppAuth?: boolean;

//   constructor(
//     readonly id: string,
//   ) {
//   }

//   setAuth(token: any, allowAppAuth: boolean, account?: string) {
//     if (token && typeof token === 'string') this.token = token;
//     this.allowAppAuth = allowAppAuth;
//     this.account = account;
//     debug('op instance', this.id, ' set auth - ', token, allowAppAuth, account);
//   }

//   opClientPromise: Promise<Client> | undefined;
//   async initSdkClient() {
//     if (!this.token) return;
//     if (this.opClientPromise) return;

//     // TODO: pass through account once SDK allows it
//     this.opClientPromise = createClient({
//       auth: this.token,
//       integrationName: 'varlock plugin',
//       integrationVersion: PLUGIN_VERSION,
//     });
//   }

//   readBatch?: Record<string, { defers: Array<DeferredPromise<string>> }> | undefined;

//   async readItem(opReference: string) {
//     if (this.token) {
//       // using JS SDK client using service account token
//       await this.initSdkClient();
//       if (this.opClientPromise) {
//         // simple batching setup, so we can use bulk read sdk method
//         let triggerBatch = false;
//         if (!this.readBatch) {
//           this.readBatch = {};
//           triggerBatch = true;
//         }
//         // add item to batch, with deferred promise
//         this.readBatch[opReference] = { defers: [] };
//         const deferred = createDeferredPromise();
//         this.readBatch[opReference].defers.push(deferred);
//         if (triggerBatch) {
//           setImmediate(() => this.executeReadBatch());
//         }
//         return deferred.promise;
//       }
//     } else if (this.allowAppAuth) {
//       // using op CLI to talk to 1Password desktop app
//       // NOTE - cli helper does its own batching, untethered to a specific op instance
//       return await opCliRead(opReference, this.account);
//     } else {
//       throw new SchemaError('Unable to authenticate with 1Password', {
//         tip: `Plugin instance (${this.id}) must be provided either a service account token or have app auth enabled (allowAppAuth=true)`,
//       });
//     }
//   }

//   private async executeReadBatch() {
//     const opClient = await this.opClientPromise;
//     if (!opClient) throw new Error('Expected op sdk to be initialized');

//     const batch = this.readBatch;
//     this.readBatch = undefined;

//     const opReferences = Object.keys(batch || {});
//     debug('bulk fetching', opReferences);
//     if (!opReferences.length) return;

//     try {
//       const result = await opClient.secrets.resolveAll(opReferences);

//       for (const ref in batch) {
//         for (const dp of batch[ref].defers) {
//           const itemResponse = result.individualResponses[ref];
//           if (itemResponse.error) {
//             dp.reject(new ResolutionError(`1Password error - ${itemResponse.error.message || itemResponse.error.type}`));
//           } else if (itemResponse.content) {
//             dp.resolve(itemResponse.content.secret);
//           } else {
//             dp.reject(new ResolutionError('bulk fetch is missing item response'));
//           }
//         }
//       }
//     } catch (err) {
//       let commonErr;
//       // 1pass sdk throws strings as errors...
//       if (typeof err === 'string') {
//         commonErr = new ResolutionError(`1Password SDK error - ${err}`);
//       } else {
//         commonErr = err as Error;
//       }

//       for (const ref in batch) {
//         for (const dp of batch[ref].defers) {
//           const wrappedErr = new Error(`1Password error - ${commonErr.message}`);
//           wrappedErr.cause = commonErr;
//           dp.reject(err);
//         }
//       }
//     }
//   }
// }
// const pluginInstances: Record<string, OpPluginInstance> = {};


plugin.registerRootDecorator({
  name: 'initKeychain',
  description: 'Initialize a keychain plugin instance for keychain() resolver',
  isFunction: true,
  async process(argsVal) {
    const instanceId = argsVal.objArgs?.id?.staticValue!.toString();
    const keychainItemName = argsVal.objArgs?.key?.staticValue!.toString();

    if (!instanceId) throw new SchemaError('Expected vault id');

    plugin.cliCtx ??= {
      keychains: {} as any,
    };

    plugin.cliCtx.keychains[instanceId] ??= {
      keychainItemName,
    };

    return { instanceId };
  },
  async execute({ instanceId }) {
  },
});


plugin.registerResolverFunction({
  name: 'keychain',
  label: 'Fetch single value from native OS keychain',
  icon: KEYCHAIN_ICON,
  argsSchema: {
    type: 'array',
    arrayMaxLength: 2,
  },
  process() {
    // if no arg, we'll default the keyname to the same
    if (!this.arrArgs?.length) {
      return { itemKey: '_DEFAULT_KEY' };
    }

    const itemKeyResolver = this.arrArgs[0];
    if (!itemKeyResolver.isStatic) {
      throw new SchemaError('Expected item key to be a static value');
    }
    const itemKey = String(itemKeyResolver.staticValue);
    return { itemKey };
  },
  async resolve({ itemKey }) {
    try {
      const value = await execAsync(`security find-generic-password -s ${itemKey} -a $USER -w`);
      return value.stdout.trim();
    } catch (err) {
      throw new ResolutionError(`Keychain item not found: ${itemKey}`, {
        // tip: `run \`varlock plugin keychain -- add ${itemKey}\` to add the item to the keychain`,
        tip: [
          'Run the following command to add it',
          `varlock plugin -n keychain -- add ${itemKey}`,
        ].join('\n'),
      });
    }
    // console.timeEnd(`keychain${itemKey}`);
    // console.log('value', value);
  },
});
