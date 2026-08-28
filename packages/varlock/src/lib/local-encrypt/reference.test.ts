import { describe, it, expect } from 'vitest';
import {
  LOCAL_SCHEME, buildVarlockReference, isKnownVarlockScheme, parseVarlockReference,
} from './reference';

describe('parseVarlockReference', () => {
  it('parses the local scheme', () => {
    expect(parseVarlockReference('local:AQID')).toEqual({ scheme: 'local', payload: 'AQID' });
  });

  it('keeps the payload intact, including base64 padding', () => {
    expect(parseVarlockReference('local:AQIDBA==').payload).toBe('AQIDBA==');
  });

  it('treats a prefixless payload as local (legacy references)', () => {
    // base64 never contains a colon, so an unprefixed payload can never be
    // mistaken for a scheme
    expect(parseVarlockReference('AQIDBA==')).toEqual({ scheme: 'local', payload: 'AQIDBA==' });
  });

  it('throws on an unknown scheme rather than trying to decrypt', () => {
    expect(() => parseVarlockReference('foo:AQID')).toThrow('unknown varlock() scheme "foo"');
  });

  it('lists the known schemes in the unknown-scheme error', () => {
    expect(() => parseVarlockReference('teamvault:AQID')).toThrow(/known schemes: "local"/);
  });

  it('does not treat a leading digit or symbol as a scheme', () => {
    // schemes must start with a letter, so these stay legacy local payloads
    expect(parseVarlockReference('9foo:AQID').scheme).toBe(LOCAL_SCHEME);
    expect(parseVarlockReference('9foo:AQID').payload).toBe('9foo:AQID');
    expect(parseVarlockReference('-foo:AQID').payload).toBe('-foo:AQID');
  });

  it('is case sensitive about the registered scheme name', () => {
    expect(() => parseVarlockReference('LOCAL:AQID')).toThrow(/unknown varlock\(\) scheme "LOCAL"/);
  });

  it('allows underscores and digits inside a scheme name', () => {
    expect(() => parseVarlockReference('team_vault2:AQID')).toThrow(/scheme "team_vault2"/);
  });

  it('handles an empty payload', () => {
    expect(parseVarlockReference('local:')).toEqual({ scheme: 'local', payload: '' });
  });
});

describe('isKnownVarlockScheme', () => {
  it('knows local and nothing else', () => {
    expect(isKnownVarlockScheme('local')).toBe(true);
    expect(isKnownVarlockScheme('foo')).toBe(false);
    // must not pick up inherited object properties
    expect(isKnownVarlockScheme('toString')).toBe(false);
  });
});

describe('buildVarlockReference', () => {
  it('builds a local reference', () => {
    expect(buildVarlockReference(LOCAL_SCHEME, 'AQIDBA==')).toBe('varlock("local:AQIDBA==")');
  });

  it('round-trips with parseVarlockReference', () => {
    const ciphertext = 'AQIDBAUGBwg=';
    const reference = buildVarlockReference(LOCAL_SCHEME, ciphertext);
    const inner = reference.slice('varlock("'.length, -'")'.length);
    expect(parseVarlockReference(inner)).toEqual({ scheme: LOCAL_SCHEME, payload: ciphertext });
  });

  it('refuses to build a reference for an unregistered scheme', () => {
    expect(() => buildVarlockReference('foo' as any, 'AQID')).toThrow('unknown varlock() scheme "foo"');
  });
});
