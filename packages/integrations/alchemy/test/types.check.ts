import * as Effect from 'effect/Effect';
import { Secrets } from '../src/index';
import { bindings } from '../src/cloudflare';

const single = Secrets<{ A: string; B?: number }>();
const multi = Secrets<{ server: { S: string }; web: { W: boolean } }>({ services: { server: 'a', web: 'b' } });
// type-level checks only (run by `tsc --noEmit`)
Effect.gen(function* typeChecks() {
  const a = yield* bindings(single);
  a.A satisfies object;
  a.B satisfies object | undefined;
  // @ts-expect-error not in schema
  a.C satisfies unknown;
  const s = yield* bindings(multi, 'server', { blob: false });
  s.S satisfies object;
  // @ts-expect-error unknown service
  yield* bindings(multi, 'nope');
  // @ts-expect-error service name needed for a services provider
  yield* bindings(multi);
});
