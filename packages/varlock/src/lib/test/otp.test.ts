import { describe, it, expect } from 'vitest';
import {
  decodeBase32Secret, decodeOtpSecret, generateHotpCode, generateTotp,
  normalizeOtpAlgorithm, parseOtpAuthUri,
} from '../otp';

// the shared secrets used by the RFC 4226 / RFC 6238 test vectors
const RFC_SECRET_SHA1 = '12345678901234567890';
const RFC_SECRET_SHA256 = '12345678901234567890123456789012';
const RFC_SECRET_SHA512 = '1234567890123456789012345678901234567890123456789012345678901234';

describe('decodeBase32Secret()', () => {
  it('decodes a base32 secret', () => {
    expect(decodeBase32Secret('GEZDGNBVGY3TQOJQ').toString('utf8')).toEqual('1234567890');
  });

  it('ignores spacing, hyphens, case, and padding', () => {
    const expected = decodeBase32Secret('GEZDGNBVGY3TQOJQ');
    expect(decodeBase32Secret('gezd gnbv gy3t qojq')).toEqual(expected);
    expect(decodeBase32Secret('GEZD-GNBV-GY3T-QOJQ')).toEqual(expected);
    expect(decodeBase32Secret('GEZDGNBVGY3TQOJQ====')).toEqual(expected);
  });

  it('rejects invalid base32 without echoing the secret', () => {
    expect(() => decodeBase32Secret('ABC!8888DEF')).toThrowError(/not valid base32/);
    try {
      decodeBase32Secret('ABC!8888DEF');
    } catch (err) {
      expect((err as Error).message).not.toContain('8888');
    }
  });

  it('rejects an empty secret', () => {
    expect(() => decodeBase32Secret('')).toThrowError(/too short/);
    expect(() => decodeBase32Secret('   ')).toThrowError(/too short/);
  });
});

describe('decodeOtpSecret()', () => {
  it('decodes hex secrets', () => {
    expect(decodeOtpSecret('3132 3334', 'hex').toString('utf8')).toEqual('1234');
  });

  it('rejects invalid hex', () => {
    expect(() => decodeOtpSecret('zzz', 'hex')).toThrowError(/not valid hex/);
    expect(() => decodeOtpSecret('abc', 'hex')).toThrowError(/not valid hex/);
  });

  it('passes ascii secrets through', () => {
    expect(decodeOtpSecret(RFC_SECRET_SHA1, 'ascii').toString('utf8')).toEqual(RFC_SECRET_SHA1);
  });
});

describe('generateHotpCode(): RFC 4226 test vectors', () => {
  const expectedCodes = [
    '755224',
    '287082',
    '359152',
    '969429',
    '338314',
    '254676',
    '287922',
    '162583',
    '399871',
    '520489',
  ];
  it.each(expectedCodes.map((code, counter) => ({ counter, code })))(
    'counter $counter → $code',
    ({ counter, code }) => {
      expect(generateHotpCode({
        secret: Buffer.from(RFC_SECRET_SHA1, 'utf8'),
        counter,
        digits: 6,
        algorithm: 'SHA1',
      })).toEqual(code);
    },
  );
});

describe('generateTotp(): RFC 6238 test vectors', () => {
  const vectors = [
    {
      time: 59, sha1: '94287082', sha256: '46119246', sha512: '90693936',
    },
    {
      time: 1111111109, sha1: '07081804', sha256: '68084774', sha512: '25091201',
    },
    {
      time: 1111111111, sha1: '14050471', sha256: '67062674', sha512: '99943326',
    },
    {
      time: 1234567890, sha1: '89005924', sha256: '91819424', sha512: '93441116',
    },
    {
      time: 2000000000, sha1: '69279037', sha256: '90698825', sha512: '38618901',
    },
    {
      time: 20000000000, sha1: '65353130', sha256: '77737706', sha512: '47863826',
    },
  ];

  it.each(vectors)('T=$time', ({
    time, sha1, sha256, sha512,
  }) => {
    const base = { digits: 8, encoding: 'ascii' as const, now: time * 1000 };
    expect(generateTotp({ ...base, secret: RFC_SECRET_SHA1, algorithm: 'SHA1' }).code).toEqual(sha1);
    expect(generateTotp({ ...base, secret: RFC_SECRET_SHA256, algorithm: 'SHA256' }).code).toEqual(sha256);
    expect(generateTotp({ ...base, secret: RFC_SECRET_SHA512, algorithm: 'SHA512' }).code).toEqual(sha512);
  });
});

describe('generateTotp()', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // base32 of RFC_SECRET_SHA1

  it('defaults to 6 digits / 30s / SHA1', () => {
    const result = generateTotp({ secret, now: 59_000 });
    expect(result).toMatchObject({ digits: 6, period: 30, algorithm: 'SHA1' });
    // same vector as RFC T=59, truncated to 6 digits
    expect(result.code).toEqual('287082');
  });

  it('keeps leading zeros', () => {
    expect(generateTotp({ secret, digits: 8, now: 1111111109_000 }).code).toEqual('07081804');
  });

  it('returns the same code within a window and a new one after it', () => {
    // 1_200_000_000_000 lands exactly on a 30s window boundary
    const first = generateTotp({ secret, now: 1_200_000_000_000 });
    const sameWindow = generateTotp({ secret, now: 1_200_000_029_999 });
    const nextWindow = generateTotp({ secret, now: 1_200_000_030_000 });
    expect(sameWindow.code).toEqual(first.code);
    expect(nextWindow.code).not.toEqual(first.code);
  });

  it('reports how long the code stays valid', () => {
    expect(generateTotp({ secret, now: 1_200_000_000_000 }).expiresInMs).toEqual(30_000);
    expect(generateTotp({ secret, now: 1_200_000_025_000 }).expiresInMs).toEqual(5_000);
  });

  it('honors a custom period', () => {
    const period60 = generateTotp({ secret, period: 60, now: 59_000 });
    expect(period60.period).toEqual(60);
    // T=59 with a 60s window is counter 0, matching the HOTP counter-0 vector
    expect(period60.code).toEqual('755224');
  });

  it('accepts a secret with the display formatting left in', () => {
    expect(generateTotp({ secret: 'gezd gnbv gy3t qojq gezd gnbv gy3t qojq', now: 59_000 }).code)
      .toEqual(generateTotp({ secret, now: 59_000 }).code);
  });

  it('rejects an empty secret', () => {
    expect(() => generateTotp({ secret: '  ' })).toThrowError(/empty/);
  });
});

describe('generateTotp() with otpauth:// URIs', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

  it('pulls params out of the URI', () => {
    const result = generateTotp({
      secret: `otpauth://totp/npm:theo?secret=${secret}&issuer=npm&algorithm=SHA256&digits=8&period=60`,
      now: 59_000,
    });
    expect(result).toMatchObject({ digits: 8, period: 60, algorithm: 'SHA256' });
  });

  it('lets explicit options override URI params', () => {
    const result = generateTotp({
      secret: `otpauth://totp/npm:theo?secret=${secret}&digits=8&period=60`,
      digits: 6,
      period: 30,
      now: 59_000,
    });
    expect(result).toMatchObject({ digits: 6, period: 30 });
    expect(result.code).toEqual(generateTotp({ secret, now: 59_000 }).code);
  });

  it('ignores the encoding option, since URI secrets are always base32', () => {
    const result = generateTotp({
      secret: `otpauth://totp/npm:theo?secret=${secret}`,
      encoding: 'hex',
      now: 59_000,
    });
    expect(result.code).toEqual(generateTotp({ secret, now: 59_000 }).code);
  });

  it('rejects HOTP URIs', () => {
    expect(() => generateTotp({ secret: `otpauth://hotp/x?secret=${secret}&counter=1` }))
      .toThrowError(/HOTP/);
  });

  it('rejects a URI with no secret param', () => {
    expect(() => generateTotp({ secret: 'otpauth://totp/npm:theo?issuer=npm' }))
      .toThrowError(/missing a `secret` param/);
  });

  it('rejects unsupported algorithms', () => {
    expect(() => parseOtpAuthUri(`otpauth://totp/x?secret=${secret}&algorithm=MD5`))
      .toThrowError(/unsupported `algorithm` param/);
  });

  it.each([5, 11])('rejects digits=%i', (digits) => {
    expect(() => parseOtpAuthUri(`otpauth://totp/x?secret=${secret}&digits=${digits}`))
      .toThrowError(/invalid `digits` param/);
  });
});

describe('normalizeOtpAlgorithm()', () => {
  it('accepts common spellings', () => {
    expect(normalizeOtpAlgorithm('sha1')).toEqual('SHA1');
    expect(normalizeOtpAlgorithm('SHA-256')).toEqual('SHA256');
    expect(normalizeOtpAlgorithm('sha_512')).toEqual('SHA512');
  });

  it('returns undefined for unsupported algorithms', () => {
    expect(normalizeOtpAlgorithm('md5')).toBeUndefined();
  });
});
