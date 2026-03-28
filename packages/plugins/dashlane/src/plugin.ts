import type { Resolver } from 'varlock/plugin-lib';
import { DashlaneManager } from './dashlane-manager';
import { validateDeviceKeys, validateSecretRef } from './validators';

const { SchemaError, ResolutionError, ValidationError } = plugin.ERRORS;

const DASHLANE_ICON = 'simple-icons:dashlane';

plugin.name = 'dashlane';
const { debug } = plugin;
debug('init - version =', plugin.version);
plugin.icon = DASHLANE_ICON;
plugin.standardVars = {
  initDecorator: '@initDashlane',
  params: {
    serviceDeviceKeys: { key: 'DASHLANE_SERVICE_DEVICE_KEYS' },
  },
};

const manager = new DashlaneManager({ SchemaError, ResolutionError });

plugin.registerRootDecorator({
  name: 'initDashlane',
  description: 'Initialize a Dashlane plugin instance for dashlane() resolver',
  isFunction: true,
  async process(argsVal) {
    return manager.processInit(argsVal.objArgs);
  },
  async execute(processResult) {
    await manager.executeInit(processResult);
  },
});

plugin.registerResolverFunction({
  name: 'dashlane',
  label: 'Fetch secret from Dashlane by dl:// reference',
  icon: DASHLANE_ICON,
  argsSchema: {
    type: 'array',
    arrayMinLength: 1,
    arrayMaxLength: 2,
  },
  process() {
    let instanceId = '_default';
    let refResolver: Resolver | undefined;

    if (this.arrArgs!.length === 1) {
      refResolver = this.arrArgs![0];
    } else if (this.arrArgs!.length === 2) {
      if (!this.arrArgs![0].isStatic) {
        throw new SchemaError('Expected instance id (first argument) to be a static value');
      }
      instanceId = String(this.arrArgs![0].staticValue);
      refResolver = this.arrArgs![1];
    } else {
      throw new SchemaError('Expected 1-2 arguments');
    }

    manager.getInstance(instanceId);

    return { instanceId, refResolver };
  },
  async resolve({ instanceId, refResolver }) {
    const instance = manager.getInstance(instanceId);
    if (!refResolver) {
      throw new SchemaError('Expected a dl:// reference argument');
    }
    const dlUri = await refResolver.resolve();
    if (typeof dlUri !== 'string') {
      throw new SchemaError('Expected dl:// reference to resolve to a string');
    }
    return await instance.readReference(dlUri);
  },
});

plugin.registerDataType({
  name: 'dashlaneDeviceKeys',
  sensitive: true,
  typeDescription: 'Service device keys for non-interactive Dashlane CLI authentication',
  icon: DASHLANE_ICON,
  docs: [
    {
      description: 'Dashlane CLI device registration',
      url: 'https://cli.dashlane.com/personal/devices',
    },
  ],
  async validate(val) {
    const error = validateDeviceKeys(val);
    if (error) throw new ValidationError(error);
  },
});

plugin.registerDataType({
  name: 'dashlaneSecretRef',
  sensitive: false,
  typeDescription: 'Dashlane secret reference URI (dl://...)',
  icon: DASHLANE_ICON,
  docs: [
    {
      description: 'Dashlane CLI read secrets',
      url: 'https://cli.dashlane.com/personal/secrets/read',
    },
  ],
  async validate(val) {
    const error = validateSecretRef(val);
    if (error) throw new ValidationError(error);
  },
});
