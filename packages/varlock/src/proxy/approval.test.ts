import { PassThrough } from 'node:stream';
import { describe, expect, test } from 'vitest';

import {
  clampLifetime,
  createApprovalRequest,
  createAutoDenyApprovalProvider,
  createTtyApprovalProvider,
  hashBody,
  isApprovalValid,
  type ApprovalRequest,
} from './approval';

type ReqInput = Parameters<typeof createApprovalRequest>[0];
function req(overrides: Partial<ReqInput> = {}): ApprovalRequest {
  return createApprovalRequest({
    method: 'POST',
    host: 'api.stripe.com',
    path: '/v1/refunds',
    body: '{"amount":100}',
    ruleId: 'api.stripe.com /v1/refunds approve',
    injectedKeys: ['STRIPE_KEY'],
    ...overrides,
  });
}

describe('createApprovalRequest', () => {
  test('binds to the request: body hash, nonce, expiry, and metadata', () => {
    const r = req();
    expect(r.bodyHash).toBe(hashBody('{"amount":100}'));
    expect(r.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(r.expiresAt).toBeGreaterThan(0);
    expect(r.injectedKeys).toEqual(['STRIPE_KEY']);
    expect(r.ruleId).toContain('approve');
  });
});

describe('isApprovalValid', () => {
  test('honors only an approval that echoes the nonce and is unexpired', () => {
    const r = req();
    expect(isApprovalValid(r, { approved: true, nonce: r.nonce })).toBe(true);
    expect(isApprovalValid(r, { approved: false, nonce: r.nonce })).toBe(false); // denied
    expect(isApprovalValid(r, { approved: true, nonce: 'wrong' })).toBe(false); // nonce mismatch
  });

  test('rejects an expired request even if approved with the right nonce', () => {
    const expired = req({ ttlMs: -1000 });
    expect(isApprovalValid(expired, { approved: true, nonce: expired.nonce })).toBe(false);
  });
});

describe('clampLifetime (schema ceiling)', () => {
  test('maxDuration=0 forces once (always ask)', () => {
    expect(clampLifetime({ kind: 'session' }, 0)).toEqual({ kind: 'once' });
    expect(clampLifetime({ kind: 'duration', durationMs: 60_000 }, 0)).toEqual({ kind: 'once' });
  });
  test('no cap (undefined) leaves the lifetime untouched', () => {
    expect(clampLifetime({ kind: 'session' }, undefined)).toEqual({ kind: 'session' });
  });
  test('a finite cap turns session into a bounded duration and shortens longer ones', () => {
    expect(clampLifetime({ kind: 'session' }, 60_000)).toEqual({ kind: 'duration', durationMs: 60_000 });
    expect(clampLifetime({ kind: 'duration', durationMs: 120_000 }, 60_000)).toEqual({ kind: 'duration', durationMs: 60_000 });
    expect(clampLifetime({ kind: 'duration', durationMs: 30_000 }, 60_000)).toEqual({ kind: 'duration', durationMs: 30_000 });
  });
});

describe('createAutoDenyApprovalProvider', () => {
  test('always denies, echoing the nonce', async () => {
    const r = req();
    const decision = await createAutoDenyApprovalProvider().requestApproval(r);
    expect(decision).toMatchObject({ approved: false, nonce: r.nonce });
    expect(isApprovalValid(r, decision)).toBe(false);
  });
});

describe('createTtyApprovalProvider', () => {
  function ttyInput() {
    const input = new PassThrough();
    (input as unknown as { isTTY: boolean }).isTTY = true;
    return input;
  }

  test('approves on "y" and the decision authorizes the request', async () => {
    const input = ttyInput();
    const output = new PassThrough();
    const provider = createTtyApprovalProvider({ input, output });
    const r = req();
    const pending = provider.requestApproval(r);
    input.write('y\n');
    const decision = await pending;
    expect(decision.approved).toBe(true);
    expect(decision.lifetime).toEqual({ kind: 'once' });
    expect(isApprovalValid(r, decision)).toBe(true);
  });

  test('"s" approves for the session, "m" for a duration window', async () => {
    const sInput = ttyInput();
    const sProvider = createTtyApprovalProvider({ input: sInput, output: new PassThrough() });
    const sPending = sProvider.requestApproval(req());
    sInput.write('s\n');
    expect((await sPending).lifetime).toEqual({ kind: 'session' });

    const mInput = ttyInput();
    const mProvider = createTtyApprovalProvider({ input: mInput, output: new PassThrough() });
    const mPending = mProvider.requestApproval(req());
    mInput.write('m\n');
    const mDecision = await mPending;
    expect(mDecision.approved).toBe(true);
    expect(mDecision.lifetime).toMatchObject({ kind: 'duration' });
  });

  test('denies on "n" (and anything that is not yes)', async () => {
    for (const answer of ['n\n', '\n', 'maybe\n']) {
      const input = ttyInput();
      const provider = createTtyApprovalProvider({ input, output: new PassThrough() });
      const pending = provider.requestApproval(req());
      input.write(answer);
      expect((await pending).approved).toBe(false);
    }
  });

  test('shows the request being approved in the prompt (no secret value)', async () => {
    const input = ttyInput();
    const output = new PassThrough();
    let prompt = '';
    output.on('data', (c: Buffer) => {
      prompt += c.toString('utf8');
    });
    const provider = createTtyApprovalProvider({ input, output });
    const pending = provider.requestApproval(req());
    input.write('y\n');
    await pending;
    expect(prompt).toContain('POST https://api.stripe.com/v1/refunds');
    expect(prompt).toContain('STRIPE_KEY'); // key name shown
  });

  test('always-ask (maxDurationMs=0) offers only once/no, and "s"/"m" are denied', async () => {
    const input = ttyInput();
    const output = new PassThrough();
    let prompt = '';
    output.on('data', (c: Buffer) => {
      prompt += c.toString('utf8');
    });
    const provider = createTtyApprovalProvider({ input, output });
    const pending = provider.requestApproval(req({ maxDurationMs: 0 }));
    input.write('s\n'); // session not offered → should be denied
    const decision = await pending;
    expect(prompt).toContain('[y] once');
    expect(prompt).not.toContain('this session');
    expect(prompt).not.toContain('min');
    expect(decision.approved).toBe(false);
  });

  test('fails closed when there is no TTY', async () => {
    const provider = createTtyApprovalProvider({ input: new PassThrough(), output: new PassThrough() });
    expect((await provider.requestApproval(req())).approved).toBe(false);
  });

  test('fails closed on timeout', async () => {
    const input = ttyInput();
    const provider = createTtyApprovalProvider({ input, output: new PassThrough(), timeoutMs: 30 });
    // never write input → the timeout fires and denies
    expect((await provider.requestApproval(req())).approved).toBe(false);
  });

  test('on EOF without an answer, denies and hints to run in the foreground', async () => {
    const input = ttyInput();
    const output = new PassThrough();
    let prompt = '';
    output.on('data', (c: Buffer) => {
      prompt += c.toString('utf8');
    });
    const provider = createTtyApprovalProvider({ input, output });
    const pending = provider.requestApproval(req());
    input.end(); // EOF — the terminal couldn't be read (e.g. backgrounded daemon)
    const decision = await pending;
    expect(decision.approved).toBe(false);
    expect(prompt).toContain('foreground of an interactive terminal');
  });
});
