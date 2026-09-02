const { plugin } = require('varlock/plugin-lib');

// A fake transform scheme exercising every option-spec surface: required options,
// enums, string lists, header names, and both item roles (consumed + wire).
plugin.registerProxyTransformScheme({
  scheme: 'test-sign',
  options: {
    tokenId: { required: true, type: 'string', itemRole: 'wire' },
    signatureHeader: { required: true, type: 'headerName' },
    mode: { type: 'enum', enumValues: ['plain', 'fancy'] },
    allowedThings: { type: 'stringList' },
  },
  apply(transform, input, nowMs) {
    return {
      ok: true,
      setHeaders: {
        [transform.signatureHeader]: `test-signed:${input.credentials.secretKey}:${input.credentials.tokenId}:${Math.floor(nowMs / 1000)}`,
      },
      removeHeaders: ['x-test-strip'],
    };
  },
});
