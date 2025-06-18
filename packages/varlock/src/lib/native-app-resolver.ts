import { ResolutionError, Resolver, SchemaError } from '@env-spec/env-graph';
import { VarlockNativeAppClient } from './native-app-client';

const varlockNativeAppClient = new VarlockNativeAppClient();

export class VarlockResolver extends Resolver {
  static fnName = 'varlock';

  label = 'varlock';
  icon = 'game-icons:locked-chest';

  async _process() {
    if (!Array.isArray(this.fnArgs)) {
      throw new SchemaError('varlock() expects a single child arg, not a key-value object');
    }
    if (this.fnArgs.length !== 1) {
      throw new SchemaError('varlock() expects a single child arg');
    }
  }

  protected async _resolve() {
    if (!Array.isArray(this.fnArgs) || this.fnArgs.length !== 1) {
      throw new Error('eval() expects a single child arg');
    }

    const encryptedValue = await this.fnArgs[0].resolve();
    if (typeof encryptedValue !== 'string') {
      throw new ResolutionError('expected encrypted value to be a string');
    }

    const decryptedValue = await varlockNativeAppClient.decrypt(encryptedValue);
    return decryptedValue;
  }
}
