/**
 * Tests for the generateOtp() resolver function.
 * The code generation itself is covered by src/lib/test/otp.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { outdent } from 'outdent';
import { DotEnvFileDataSource, EnvGraph } from '../index';
import { ResolutionError, SchemaError } from '../lib/errors';

// base32 of '12345678901234567890'
const TEST_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

async function loadAndResolve(envContent: string) {
  const g = new EnvGraph();
  const source = new DotEnvFileDataSource('.env.schema', {
    overrideContents: outdent`
      # @defaultRequired=false
      # ---
      ${envContent}
    `,
  });
  await g.setRootDataSource(source);
  await g.finishLoad();
  await g.resolveEnvValues();
  return g;
}

describe('generateOtp()', () => {
  it('generates a 6 digit code by default', async () => {
    const g = await loadAndResolve(`A=generateOtp("${TEST_SECRET}")`);
    expect(g.configSchema.A.errors).toEqual([]);
    expect(g.configSchema.A.resolvedValue).toMatch(/^\d{6}$/);
  });

  it('resolves as a string, so leading zeros survive', async () => {
    const g = await loadAndResolve(`A=generateOtp("${TEST_SECRET}")`);
    expect(typeof g.configSchema.A.resolvedValue).toEqual('string');
  });

  it('works with a secret from another item', async () => {
    const g = await loadAndResolve(outdent`
      # @internal @sensitive
      TOTP_SECRET=${TEST_SECRET}
      OTP=generateOtp(ref(TOTP_SECRET))
    `);
    expect(g.configSchema.OTP.errors).toEqual([]);
    expect(g.configSchema.OTP.resolvedValue).toMatch(/^\d{6}$/);
  });

  it('works with an expanded secret reference', async () => {
    const g = await loadAndResolve(outdent`
      # @internal
      TOTP_SECRET=${TEST_SECRET}
      OTP=generateOtp("\${TOTP_SECRET}")
    `);
    expect(g.configSchema.OTP.errors).toEqual([]);
    expect(g.configSchema.OTP.resolvedValue).toMatch(/^\d{6}$/);
  });

  it('accepts an otpauth:// URI', async () => {
    const g = await loadAndResolve(`A=generateOtp("otpauth://totp/npm:theo?secret=${TEST_SECRET}&issuer=npm&digits=8")`);
    expect(g.configSchema.A.errors).toEqual([]);
    expect(g.configSchema.A.resolvedValue).toMatch(/^\d{8}$/);
  });

  it('honors digits, period, and algorithm options', async () => {
    const g = await loadAndResolve(
      `A=generateOtp("${TEST_SECRET}", digits=8, period=60, algorithm=SHA256)`,
    );
    expect(g.configSchema.A.errors).toEqual([]);
    expect(g.configSchema.A.resolvedValue).toMatch(/^\d{8}$/);
  });

  it('accepts a duration string for period', async () => {
    const g = await loadAndResolve(`A=generateOtp("${TEST_SECRET}", period="60s")`);
    expect(g.configSchema.A.errors).toEqual([]);
    expect(g.configSchema.A.resolvedValue).toMatch(/^\d{6}$/);
  });

  it('accepts hex encoded secrets', async () => {
    const g = await loadAndResolve('A=generateOtp("3132333435363738393031323334353637383930", encoding=hex)');
    expect(g.configSchema.A.errors).toEqual([]);
    expect(g.configSchema.A.resolvedValue).toMatch(/^\d{6}$/);
  });

  it('requires exactly one positional arg', async () => {
    const noArgs = await loadAndResolve('A=generateOtp()');
    expect(noArgs.configSchema.A.errors.length).toBeGreaterThan(0);
    const twoArgs = await loadAndResolve(`A=generateOtp("${TEST_SECRET}", 6)`);
    expect(twoArgs.configSchema.A.errors.length).toBeGreaterThan(0);
  });

  it('rejects out of range digits', async () => {
    const g = await loadAndResolve(`A=generateOtp("${TEST_SECRET}", digits=4)`);
    expect(g.configSchema.A.errors[0]).toBeInstanceOf(SchemaError);
    expect(g.configSchema.A.errors[0].message).toContain('digits');
  });

  it('rejects an unsupported algorithm', async () => {
    const g = await loadAndResolve(`A=generateOtp("${TEST_SECRET}", algorithm=MD5)`);
    expect(g.configSchema.A.errors[0]).toBeInstanceOf(SchemaError);
    expect(g.configSchema.A.errors[0].message).toContain('algorithm');
  });

  it('rejects an unsupported encoding', async () => {
    const g = await loadAndResolve(`A=generateOtp("${TEST_SECRET}", encoding=base64)`);
    expect(g.configSchema.A.errors[0]).toBeInstanceOf(SchemaError);
    expect(g.configSchema.A.errors[0].message).toContain('encoding');
  });

  it('rejects a sub-second period', async () => {
    const zero = await loadAndResolve(`A=generateOtp("${TEST_SECRET}", period=0)`);
    expect(zero.configSchema.A.errors[0]).toBeInstanceOf(SchemaError);
    // the duration parser reads a bare numeric string as ms, so this is 60ms
    const bareString = await loadAndResolve(`A=generateOtp("${TEST_SECRET}", period="60")`);
    expect(bareString.configSchema.A.errors[0]).toBeInstanceOf(SchemaError);
    expect(bareString.configSchema.A.errors[0].message).toContain('at least 1 second');
  });

  it('fails resolution on an invalid secret, without leaking it', async () => {
    const g = await loadAndResolve('A=generateOtp("not-a-valid-secret!")');
    expect(g.configSchema.A.resolutionError).toBeInstanceOf(ResolutionError);
    expect(g.configSchema.A.resolutionError!.message).toContain('generateOtp()');
    expect(g.configSchema.A.resolutionError!.message).not.toContain('not-a-valid-secret');
  });

  it.each([
    `otpauth://totp/x?secret=${TEST_SECRET}&algorithm=SENSITIVE_MARKER`,
    `otpauth://SENSITIVE_MARKER/x?secret=${TEST_SECRET}`,
  ])('does not leak malformed URI values in resolution errors', async (secret) => {
    const g = await loadAndResolve(`A=generateOtp("${secret}")`);
    expect(g.configSchema.A.resolutionError).toBeInstanceOf(ResolutionError);
    expect(g.configSchema.A.resolutionError!.message).not.toContain('SENSITIVE_MARKER');
  });

  it('fails resolution when the secret is empty', async () => {
    const g = await loadAndResolve(outdent`
      # @internal
      TOTP_SECRET=
      OTP=generateOtp(ref(TOTP_SECRET))
    `);
    expect(g.configSchema.OTP.resolutionError).toBeInstanceOf(ResolutionError);
  });

  it('cannot be wrapped in cache()', async () => {
    const g = await loadAndResolve(`A=cache(generateOtp("${TEST_SECRET}"))`);
    const errors = g.configSchema.A.errors.filter((e) => !e.isWarning);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain('cannot cache generateOtp()');
  });

  it('can wrap a cached secret', async () => {
    const g = await loadAndResolve(`A=generateOtp(cache("${TEST_SECRET}"))`);
    expect(g.configSchema.A.errors.filter((e) => !e.isWarning)).toEqual([]);
    expect(g.configSchema.A.resolvedValue).toMatch(/^\d{6}$/);
  });
});
