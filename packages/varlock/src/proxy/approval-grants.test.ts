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
  createApprovalRequest, type ApprovalProvider, type ApprovalScope,
} from './approval';

// Redirect the grants dir into a throwaway XDG_CONFIG_HOME (grantsDir resolves lazily).
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

const RULE = 'api.stripe.com POST /v1/refunds approve';

function grant(overrides: Partial<ApprovalGrant> = {}) {
  return {
    ruleId: RULE, host: 'api.stripe.com', scope: 'session' as const, grantedBy: 'tty', ...overrides,
  };
}

describe('approval grant store', () => {
  test('add + findMatch returns a session grant for the same rule', async () => {
    const store = createApprovalGrantStore('sess-1');
    await store.add(grant());
    const match = await store.findMatch(RULE);
    expect(match).toMatchObject({ ruleId: RULE, scope: 'session' });
    expect(match!.id).toMatch(/^[0-9a-f]+$/);
  });

  test('does not match a different rule', async () => {
    const store = createApprovalGrantStore('sess-1');
    await store.add(grant());
    expect(await store.findMatch('some.other.rule')).toBeUndefined();
  });

  test('a duration grant matches before expiry and not after', async () => {
    const store = createApprovalGrantStore('sess-1');
    await store.add(grant({ scope: 'duration', expiresAt: Date.now() + 10_000 }));
    expect(await store.findMatch(RULE)).toBeDefined();

    const store2 = createApprovalGrantStore('sess-2');
    await store2.add(grant({ scope: 'duration', expiresAt: Date.now() - 1_000 }));
    expect(await store2.findMatch(RULE)).toBeUndefined();
  });

  test('grants are isolated per session (own file)', async () => {
    const a = createApprovalGrantStore('sess-a');
    await a.add(grant());
    const b = createApprovalGrantStore('sess-b');
    expect(await b.findMatch(RULE)).toBeUndefined();
  });

  test('destroy removes the grant file', async () => {
    const store = createApprovalGrantStore('sess-x');
    await store.add(grant());
    expect(existsSync(store.filePath)).toBe(true);
    await store.destroy();
    expect(existsSync(store.filePath)).toBe(false);
    expect(await store.findMatch(RULE)).toBeUndefined();
  });
});

function req(ruleId: string | undefined = RULE) {
  return createApprovalRequest({
    method: 'POST', host: 'api.stripe.com', path: '/v1/refunds', body: 'x', ruleId,
  });
}

describe('granting approval provider', () => {
  test('persists a session-scope approval, then auto-approves without prompting again', async () => {
    const store = createApprovalGrantStore('sess-1');
    let innerCalls = 0;
    const inner: ApprovalProvider = {
      async requestApproval(r) {
        innerCalls += 1;
        return { approved: true, nonce: r.nonce, scope: { kind: 'session' } as ApprovalScope };
      },
    };
    const provider = createGrantingApprovalProvider({ inner, store });

    const first = await provider.requestApproval(req());
    expect(first.approved).toBe(true);
    expect(innerCalls).toBe(1);
    expect((await store.list())).toHaveLength(1);

    // second matching request → auto-approved, inner NOT called again
    const second = await provider.requestApproval(req());
    expect(second.approved).toBe(true);
    expect(second.reason).toMatch(/auto-approved/);
    expect(innerCalls).toBe(1);
  });

  test('a once-scope approval is not persisted (re-prompts next time)', async () => {
    const store = createApprovalGrantStore('sess-1');
    let innerCalls = 0;
    const inner: ApprovalProvider = {
      async requestApproval(r) {
        innerCalls += 1;
        return { approved: true, nonce: r.nonce, scope: { kind: 'once' } };
      },
    };
    const provider = createGrantingApprovalProvider({ inner, store });

    await provider.requestApproval(req());
    await provider.requestApproval(req());
    expect(innerCalls).toBe(2);
    expect(await store.list()).toHaveLength(0);
  });

  test('a denial is not persisted and passes through', async () => {
    const store = createApprovalGrantStore('sess-1');
    const inner: ApprovalProvider = {
      async requestApproval(r) { return { approved: false, nonce: r.nonce }; },
    };
    const provider = createGrantingApprovalProvider({ inner, store });
    expect((await provider.requestApproval(req())).approved).toBe(false);
    expect(await store.list()).toHaveLength(0);
  });

  test('a duration approval persists with an expiry and records grantedBy', async () => {
    const store = createApprovalGrantStore('sess-1');
    const inner: ApprovalProvider = {
      async requestApproval(r) { return { approved: true, nonce: r.nonce, scope: { kind: 'duration', durationMs: 60_000 } }; },
    };
    const provider = createGrantingApprovalProvider({ inner, store, grantedBy: 'tty' });
    await provider.requestApproval(req());
    const [g] = await store.list();
    expect(g).toMatchObject({ scope: 'duration', grantedBy: 'tty' });
    expect(g!.expiresAt).toBeGreaterThan(Date.now());
  });
});
