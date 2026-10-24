// Preloaded (NODE_OPTIONS=--import) into every node process a test starts, including the mapper process that tsc
// spawns. Records and refuses any outgoing connection or DNS lookup, so a test can assert that none was attempted.
// Writes one JSON line per event to $NETWORK_GUARD_LOG.
import fs from 'node:fs';
import net from 'node:net';
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';

const logFile = process.env.NETWORK_GUARD_LOG;
const record = (event) => {
  if (logFile) fs.appendFileSync(logFile, `${JSON.stringify({ pid: process.pid, ...event })}\n`);
};
record({ kind: 'loaded', argv: process.argv.slice(1) });

const refuse = (what, target) => {
  record({ kind: 'network', what, target: String(target) });
  return new Error(`network-guard: ${what} ${target} refused`);
};

const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function connect(...args) {
  const opts = args[0];
  // local IPC (unix sockets, named pipes) is how tools talk to each other; only network targets count
  if (typeof opts === 'string' || (opts && typeof opts === 'object' && opts.path)) return origConnect.apply(this, args);
  const target = typeof opts === 'object' ? `${opts.host ?? ''}:${opts.port ?? ''}` : `${args[1] ?? ''}:${opts}`;
  throw refuse('net.connect', target);
};
dns.lookup = (host, ...rest) => {
  const cb = rest.at(-1);
  const err = refuse('dns.lookup', host);
  if (typeof cb === 'function') process.nextTick(() => cb(err));
};
dns.promises.lookup = async (host) => {
  throw refuse('dns.promises.lookup', host);
};
globalThis.fetch = async (input) => {
  throw refuse('fetch', input?.url ?? input);
};
syncBuiltinESMExports();
