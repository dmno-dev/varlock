import { plugin } from 'varlock/plugin-lib';

import { signAwsSigv4Transform } from './sigv4';

plugin.name = 'aws-sigv4';
const { debug } = plugin;
debug('init - version =', plugin.version);
plugin.icon = 'skill-icons:aws-dark';

plugin.registerProxyTransformScheme({
  scheme: 'aws-sigv4',
  options: {
    // The AWS access key id item. Wire-visible: it travels in the Credential
    // scope of the Authorization header (region/service are parsed from the
    // inbound placeholder-signed request, so they need no configuration).
    keyId: { required: true, type: 'string', itemRole: 'wire' },
    // Session token item for temporary credentials; sent and signed as
    // X-Amz-Security-Token.
    sessionToken: { type: 'string', itemRole: 'wire' },
    // Optional policy gates on what the proxy is willing to sign for.
    allowedRegions: { type: 'stringList' },
    allowedServices: { type: 'stringList' },
  },
  apply: signAwsSigv4Transform,
});
