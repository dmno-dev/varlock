import { DashlanePluginInstance } from './dashlane-instance';

/** Shared error class stubs -- replaced with plugin.ERRORS at runtime */
export interface PluginErrors {
  SchemaError: new (msg: string, opts?: { tip?: string }) => Error;
  ResolutionError: new (msg: string, opts?: { tip?: string }) => Error;
}

/** Simulates the shape of a varlock decorator arg value */
export interface ArgValue {
  isStatic: boolean;
  staticValue?: unknown;
  resolve(): Promise<unknown>;
}

export class DashlaneManager {
  readonly instances: Record<string, DashlanePluginInstance> = {};

  constructor(private errors: PluginErrors) {}

  /**
   * Process phase of @initDashlane -- validates static args, creates instance.
   * Called at schema parse time.
   */
  processInit(objArgs?: Record<string, ArgValue>) {
    const { SchemaError } = this.errors;

    // Validate id is static if provided
    if (objArgs?.id && !objArgs.id.isStatic) {
      throw new SchemaError('Expected id to be static');
    }
    const id = String(objArgs?.id?.staticValue || '_default');

    if (this.instances[id]) {
      throw new SchemaError(`Instance with id "${id}" already initialized`);
    }

    if (objArgs?.autoSync && !objArgs.autoSync.isStatic) {
      throw new SchemaError('Expected autoSync to be static');
    }
    const autoSync = objArgs?.autoSync?.staticValue === true
      || objArgs?.autoSync?.staticValue === 'true';

    if (objArgs?.lockOnExit && !objArgs.lockOnExit.isStatic) {
      throw new SchemaError('Expected lockOnExit to be static');
    }
    const lockOnExit = objArgs?.lockOnExit
      ? (objArgs.lockOnExit.staticValue === true || objArgs.lockOnExit.staticValue === 'true')
      : undefined;

    if (objArgs?.allowMissing && !objArgs.allowMissing.isStatic) {
      throw new SchemaError('Expected allowMissing to be static');
    }
    const allowMissing = objArgs?.allowMissing
      ? (objArgs.allowMissing.staticValue === true || objArgs.allowMissing.staticValue === 'true')
      : undefined;

    if (objArgs?.timeoutMs && !objArgs.timeoutMs.isStatic) {
      throw new SchemaError('Expected timeoutMs to be static');
    }
    let timeoutMs: number | undefined;
    if (objArgs?.timeoutMs) {
      timeoutMs = Number(objArgs.timeoutMs.staticValue);
      if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
        throw new SchemaError('Expected timeoutMs to be a positive integer (milliseconds)');
      }
    }

    this.instances[id] = new DashlanePluginInstance(id, this.errors.ResolutionError);

    return {
      id,
      autoSync,
      lockOnExit,
      allowMissing,
      timeoutMs,
      serviceDeviceKeysResolver: objArgs?.serviceDeviceKeys,
    };
  }

  /**
   * Execute phase of @initDashlane -- resolves dynamic args, configures instance.
   * Called at resolution time.
   */
  async executeInit({
    id, autoSync, lockOnExit, allowMissing, timeoutMs, serviceDeviceKeysResolver,
  }: {
    id: string;
    autoSync?: boolean;
    lockOnExit?: boolean;
    allowMissing?: boolean;
    timeoutMs?: number;
    serviceDeviceKeysResolver?: ArgValue;
  }) {
    const serviceDeviceKeys = serviceDeviceKeysResolver
      ? await serviceDeviceKeysResolver.resolve()
      : undefined;

    this.instances[id].configure(
      serviceDeviceKeys && typeof serviceDeviceKeys === 'string'
        ? serviceDeviceKeys
        : undefined,
      {
        autoSync, lockOnExit, allowMissing, timeoutMs,
      },
    );
  }

  private exitHandlerRegistered = false;

  registerExitHandler(): void {
    if (this.exitHandlerRegistered) return;
    this.exitHandlerRegistered = true;
    process.on('exit', () => this.lockAllSync());
  }

  lockAllSync(): void {
    for (const instance of Object.values(this.instances)) {
      instance.lockVaultSync();
    }
  }

  /** Get instance by id, throwing helpful errors if not found */
  getInstance(instanceId: string): DashlanePluginInstance {
    const { SchemaError } = this.errors;

    if (!Object.keys(this.instances).length) {
      throw new SchemaError('No Dashlane plugin instances found', {
        tip: 'Initialize at least one Dashlane plugin instance using the @initDashlane() decorator',
      });
    }

    const instance = this.instances[instanceId];
    if (!instance) {
      if (instanceId === '_default') {
        throw new SchemaError('Dashlane plugin instance (without id) not found', {
          tip: [
            'Either remove the `id` param from your @initDashlane call',
            'or use `dashlane(id, ref)` to select an instance by id',
            `Available ids: ${Object.keys(this.instances).join(', ')}`,
          ].join('\n'),
        });
      } else {
        throw new SchemaError(`Dashlane plugin instance id "${instanceId}" not found`, {
          tip: `Available ids: ${Object.keys(this.instances).join(', ')}`,
        });
      }
    }

    return instance;
  }
}
