import { describe, expect, test } from 'vitest';

import {
  buildSessionEnvPayload,
  decodeSessionEnvPayload,
  encodeSessionEnvPayload,
} from './session-env-payload';

const GRAPH = {
  sources: [],
  settings: { redactLogs: true },
  config: {
    API_KEY: { value: 'vlk_placeholder_API_KEY_abc', isSensitive: true },
    LOG_LEVEL: { value: 'info', isSensitive: false },
  },
} as any;

describe('session env payload encode/decode', () => {
  test('round-trips the payload the one-shot path uses', () => {
    const payload = buildSessionEnvPayload({
      resolvedEnv: { API_KEY: 'vlk_placeholder_API_KEY_abc', LOG_LEVEL: 'info' },
      omittedKeys: ['ADMIN_TOKEN'],
      serializedGraph: GRAPH,
    });
    const decoded = decodeSessionEnvPayload(encodeSessionEnvPayload(payload));
    expect(decoded).toEqual(payload);
  });

  test.each([
    ['not JSON', 'nope{'],
    ['not an object', '"str"'],
    ['missing env', JSON.stringify({ omittedKeys: [], serializedGraph: { config: {} } })],
    ['non-string env value', JSON.stringify({ env: { A: 1 }, omittedKeys: [], serializedGraph: { config: {} } })],
    ['omittedKeys not an array', JSON.stringify({ env: {}, omittedKeys: 'x', serializedGraph: { config: {} } })],
    ['omittedKeys with non-strings', JSON.stringify({ env: {}, omittedKeys: [1], serializedGraph: { config: {} } })],
    ['serializedGraph missing config', JSON.stringify({ env: {}, omittedKeys: [], serializedGraph: {} })],
  ])('rejects a malformed payload: %s', (_label, raw) => {
    expect(() => decodeSessionEnvPayload(raw)).toThrow();
  });
});
