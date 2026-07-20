import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import {
  afterEach, beforeEach, describe, expect, test,
} from 'vitest';

import {
  createApprovalGrantStore,
  createGrantingApprovalProvider,
  type ApprovalGrant,
} from './approval-grants';
import {
  createApprovalRequest, type ApprovalLifetime, type ApprovalProvider,
} from './approval';

// Redirect the grants dir into a throwaway XDG_CONFIG_HOME (the path resolves lazily).
let tmpDir: string;
let prevXdg: string | undefined;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(os.tmpdir(), 'varlock-grants-test-'));
  prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tmpDir;
});

afterEach(async () => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
  await rm(tmpDir, { recursive: true, force: true });
});

const KEY = 'api.stripe.com approval POST api.stripe.com/v1/refunds';

function grant(overrides: Partial<ApprovalGrant> = {}) {
  return {
    grantKey: KEY,
    ruleId: 'api.stripe.com approval',
    host: 'api.stripe.com',
    kind: 'session' as const,
    grantedBy: 'tty',
    ...overrides,
  };
}

describe('approval grant store', () => {
  test('add + findMatch returns a session grant for the same key', async () => {
    const store = createApprovalGrantStore('sess-1');
    await store.add(grant());
    const match = await store.findMatch(KEY);
    expect(match).toMatchObject({ grantKey: KEY, kind: 'session' });
    expect(match!.id).toMatch(/^[0-9a-f]+$/);
  });

  test('does not match a different key', async () => {
    const store = createApprovalGrantStore('sess-1');
    await store.add(grant());
    expect(await store.findMatch('some other key')).toBeUndefined();
  });

  test('a duration grant matches before expiry and not after', async () => {
    const store = createApprovalGrantStore('sess-1');
    await store.add(grant({ kind: 'duration', expiresAt: Date.now() + 10_000 }));
    expect(await store.findMatch(KEY)).toBeDefined();

    const store2 = createApprovalGrantStore('sess-2');
    await store2.add(grant({ kind: 'duration', expiresAt: Date.now() - 1_000 }));
    expect(await store2.findMatch(KEY)).toBeUndefined();
  });

  test('grants are isolated per session (own file)', async () => {
    const a = createApprovalGrantStore('sess-a');
    await a.add(grant());
    const b = createApprovalGrantStore('sess-b');
    expect(await b.findMatch(KEY)).toBeUndefined();
  });

  test('grants live in the session directory as part of its durable record', async () => {
    const store = createApprovalGrantStore('sess-x');
    await store.add(grant());
    expect(existsSync(store.filePath)).toBe(true);
    // Co-located with the session record (proxy/sessions/<uuid>/grants.jsonl), not
    // a separate grants/ tree — and not destroyed on stop.
    expect(store.filePath).toMatch(/[/\\]proxy[/\\]sessions[/\\]sess-x[/\\]grants\.jsonl$/);
  });
});

function req(opts: { maxDurationMs?: number; ruleId?: string } = {}) {
  return createApprovalRequest({
    method: 'POST',
    host: 'api.stripe.com',
    path: '/v1/refunds',
    body: 'x',
    ruleId: opts.ruleId ?? 'api.stripe.com approval',
    ...(opts.maxDurationMs !== undefined ? { maxDurationMs: opts.maxDurationMs } : {}),
  });
}

function innerReturning(lifetime: ApprovalLifetime): { provider: ApprovalProvider; calls: () => number } {
  let calls = 0;
  return {
    provider: {
      async requestApproval(r) {
        calls += 1;
        return { approved: true, nonce: r.nonce, lifetime };
      },
    },
    calls: () => calls,
  };
}

describe('granting approval provider', () => {
  test('persists a session approval, then auto-approves without prompting again', async () => {
    const store = createApprovalGrantStore('sess-1');
    const inner = innerReturning({ kind: 'session' });
    const provider = createGrantingApprovalProvider({ inner: inner.provider, store });

    expect((await provider.requestApproval(req())).approved).toBe(true);
    expect(inner.calls()).toBe(1);
    expect(await store.list()).toHaveLength(1);

    const second = await provider.requestApproval(req());
    expect(second.approved).toBe(true);
    expect(second.reason).toMatch(/auto-approved/);
    expect(inner.calls()).toBe(1); // inner not consulted again
  });

  test('a once approval is not persisted (re-prompts)', async () => {
    const store = createApprovalGrantStore('sess-1');
    const inner = innerReturning({ kind: 'once' });
    const provider = createGrantingApprovalProvider({ inner: inner.provider, store });
    await provider.requestApproval(req());
    await provider.requestApproval(req());
    expect(inner.calls()).toBe(2);
    expect(await store.list()).toHaveLength(0);
  });

  test('a denial is not persisted and passes through', async () => {
    const store = createApprovalGrantStore('sess-1');
    const inner: ApprovalProvider = {
      async requestApproval(r) {
        return { approved: false, nonce: r.nonce };
      },
    };
    const provider = createGrantingApprovalProvider({ inner, store });
    expect((await provider.requestApproval(req())).approved).toBe(false);
    expect(await store.list()).toHaveLength(0);
  });

  test('maxDuration clamps a session approval to a bounded duration grant', async () => {
    const store = createApprovalGrantStore('sess-1');
    const inner = innerReturning({ kind: 'session' });
    const provider = createGrantingApprovalProvider({ inner: inner.provider, store });
    await provider.requestApproval(req({ maxDurationMs: 60_000 }));
    const [g] = await store.list();
    expect(g.kind).toBe('duration');
    expect(g.expiresAt).toBeGreaterThan(Date.now());
    expect(g.expiresAt).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  test('maxDuration=0 (always ask) never stores or honors a grant', async () => {
    const store = createApprovalGrantStore('sess-1');
    const inner = innerReturning({ kind: 'session' });
    const provider = createGrantingApprovalProvider({ inner: inner.provider, store });
    await provider.requestApproval(req({ maxDurationMs: 0 }));
    await provider.requestApproval(req({ maxDurationMs: 0 }));
    expect(inner.calls()).toBe(2); // always re-asked
    expect(await store.list()).toHaveLength(0); // never remembered
  });
});
