import { describe } from 'vitest';
import { defineNextjsTests } from './nextjs-shared';

// Early-warning canary against next@canary — the integration relies on several
// version-coupled mechanisms (@next/env override surface, env file watch list,
// which process loads env, turbopack runtime file layout), so we want to hear
// about upstream changes before a stable release ships them.
//
// Runs on a schedule via nextjs-canary.yaml, NOT as part of PR CI (canary
// breakage shouldn't block unrelated PRs). Gated by env var so plain local
// `bun run test` doesn't pull next@canary either.
describe.skipIf(!process.env.NEXTJS_CANARY)('next@canary', () => {
  defineNextjsTests('canary', import.meta.dirname);
});
