/**
 * TOTP / HOTP code generation (RFC 4226 + RFC 6238).
 *
 * Powers the `generateOtp()` resolver function, so a TOTP seed held in your env
 * schema (usually `@internal` and encrypted) can be turned into the 6-digit code
 * a CLI like `aws sts get-session-token --token-code ...` asks for.
 *
 * Error messages here must never echo any part of the secret, since resolver
 * errors are printed unredacted.
 */

/* eslint-disable no-bitwise */

import { createHmac } from 'node:crypto';

export const OTP_ALGORITHMS = ['SHA1', 'SHA256', 'SHA512'] as const;
export type OtpAlgorithm = typeof OTP_ALGORITHMS[number];

export const OTP_SECRET_ENCODINGS = ['base32', 'hex', 'ascii'] as const;
export type OtpSecretEncoding = typeof OTP_SECRET_ENCODINGS[number];

export const OTP_DEFAULTS = {
  digits: 6,
  period: 30,
  algorithm: 'SHA1' as OtpAlgorithm,
  encoding: 'base32' as OtpSecretEncoding,
};

/** Accepts `SHA1`, `sha-256`, etc. Returns undefined if not a supported algorithm. */
export function normalizeOtpAlgorithm(input: string): OtpAlgorithm | undefined {
  const normalized = input.replace(/[\s_-]/g, '').toUpperCase();
  return (OTP_ALGORITHMS as ReadonlyArray<string>).includes(normalized)
    ? normalized as OtpAlgorithm
    : undefined;
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Decodes an RFC 4648 base32 secret. Seeds get displayed in all sorts of ways
 * (lowercase, space or hyphen separated groups of 4, with or without padding)
 * so we normalize rather than being strict about it.
 */
export function decodeBase32Secret(input: string): Buffer {
  const normalized = input.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: Array<number> = [];
  for (const char of normalized) {
    const charIndex = BASE32_ALPHABET.indexOf(char);
    if (charIndex === -1) throw new Error('secret is not valid base32');
    // 12 bits is the most we ever hold (7 leftover + 5 new) before flushing a byte
    value = ((value << 5) | charIndex) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >> bits) & 0xff);
    }
  }
  if (!bytes.length) throw new Error('secret is too short');
  return Buffer.from(bytes);
}

export function decodeOtpSecret(secret: string, encoding: OtpSecretEncoding): Buffer {
  if (encoding === 'base32') return decodeBase32Secret(secret);
  if (encoding === 'hex') {
    const normalized = secret.replace(/[\s-]/g, '');
    if (!/^[0-9a-fA-F]+$/.test(normalized) || normalized.length % 2 !== 0) {
      throw new Error('secret is not valid hex');
    }
    return Buffer.from(normalized, 'hex');
  }
  const buf = Buffer.from(secret, 'utf8');
  if (!buf.length) throw new Error('secret is empty');
  return buf;
}

/** Generates an HOTP code for a specific counter value (RFC 4226) */
export function generateHotpCode(opts: {
  secret: Buffer;
  counter: number | bigint;
  digits: number;
  algorithm: OtpAlgorithm;
}): string {
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(opts.counter));

  const hmac = createHmac(opts.algorithm.toLowerCase(), opts.secret).update(counterBuf).digest();

  // dynamic truncation - low 4 bits of the last byte pick a 4-byte window
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);

  return String(binary % (10 ** opts.digits)).padStart(opts.digits, '0');
}

export type ParsedOtpAuthUri = {
  secret: string;
  digits?: number;
  period?: number;
  algorithm?: OtpAlgorithm;
};

/**
 * Parses an `otpauth://totp/...` URI - the format behind 2FA setup QR codes, and
 * what password managers hand back for a one-time password field.
 */
export function parseOtpAuthUri(uri: string): ParsedOtpAuthUri {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error('secret looks like an otpauth:// URI but could not be parsed');
  }

  const otpType = parsed.host.toLowerCase();
  if (otpType === 'hotp') {
    throw new Error('counter-based (HOTP) otpauth:// URIs are not supported, only time-based (TOTP)');
  }
  if (otpType !== 'totp') {
    throw new Error('unsupported otpauth:// URI type, expected "totp"');
  }

  const secret = parsed.searchParams.get('secret');
  if (!secret) throw new Error('otpauth:// URI is missing a `secret` param');

  const result: ParsedOtpAuthUri = { secret };

  const digits = parsed.searchParams.get('digits');
  if (digits) {
    const digitsNum = Number(digits);
    if (!Number.isInteger(digitsNum) || digitsNum < 6 || digitsNum > 10) {
      throw new Error('otpauth:// URI has an invalid `digits` param (must be between 6 and 10)');
    }
    result.digits = digitsNum;
  }

  const period = parsed.searchParams.get('period');
  if (period) {
    const periodNum = Number(period);
    if (!Number.isInteger(periodNum) || periodNum <= 0) {
      throw new Error('otpauth:// URI has an invalid `period` param');
    }
    result.period = periodNum;
  }

  const algorithm = parsed.searchParams.get('algorithm');
  if (algorithm) {
    const normalized = normalizeOtpAlgorithm(algorithm);
    if (!normalized) throw new Error('otpauth:// URI has an unsupported `algorithm` param');
    result.algorithm = normalized;
  }

  return result;
}

export type GenerateTotpOptions = {
  /** base32 secret (default), an encoding matching `encoding`, or a full `otpauth://totp/...` URI */
  secret: string;
  digits?: number;
  /** length of each code's validity window, in seconds */
  period?: number;
  algorithm?: OtpAlgorithm;
  encoding?: OtpSecretEncoding;
  /** unix time in ms - defaults to now */
  now?: number;
};

export type GeneratedTotp = {
  code: string;
  /** how long the returned code stays valid, in ms */
  expiresInMs: number;
  digits: number;
  period: number;
  algorithm: OtpAlgorithm;
};

/**
 * Generates a time-based one-time password. Params encoded in an `otpauth://` URI
 * are used as defaults, and explicitly passed options win over them.
 */
export function generateTotp(opts: GenerateTotpOptions): GeneratedTotp {
  const rawSecret = opts.secret.trim();
  if (!rawSecret) throw new Error('secret is empty');

  let secretStr = rawSecret;
  let uriParams: ParsedOtpAuthUri | undefined;
  if (/^otpauth:\/\//i.test(rawSecret)) {
    uriParams = parseOtpAuthUri(rawSecret);
    secretStr = uriParams.secret;
  }

  const digits = opts.digits ?? uriParams?.digits ?? OTP_DEFAULTS.digits;
  const period = opts.period ?? uriParams?.period ?? OTP_DEFAULTS.period;
  const algorithm = opts.algorithm ?? uriParams?.algorithm ?? OTP_DEFAULTS.algorithm;
  // an otpauth:// URI always carries a base32 secret, regardless of the `encoding` option
  const encoding = uriParams ? 'base32' : (opts.encoding ?? OTP_DEFAULTS.encoding);

  const secret = decodeOtpSecret(secretStr, encoding);

  const now = opts.now ?? Date.now();
  const periodMs = period * 1000;
  const counter = Math.floor(now / periodMs);

  return {
    code: generateHotpCode({
      secret, counter, digits, algorithm,
    }),
    expiresInMs: periodMs - (now % periodMs),
    digits,
    period,
    algorithm,
  };
}
