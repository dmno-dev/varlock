import ansis from 'ansis';

import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';
import * as localEncrypt from '../../lib/local-encrypt';
import type { SessionGrantInfo } from '../../lib/local-encrypt';
import { commandSpec } from './sessions.command-spec';

export { commandSpec };

/** "4m", "2h 10m", "expired": enough to decide whether to bother locking */
function formatRemaining(ms: number): string {
  if (ms <= 0) return 'expired';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString();
}

function renderTable(sessions: Array<SessionGrantInfo>) {
  const rows = sessions.map((session) => [
    session.sessionId,
    session.keyId,
    formatTime(session.sessionUnlockedAt),
    formatRemaining(session.expiresInMs),
    String(session.useCount),
    session.lockOn,
  ]);
  const headers = ['SESSION', 'KEY', 'UNLOCKED', 'EXPIRES IN', 'USES', 'LOCKS ON'];

  const widths = headers.map((header, column) => Math.max(
    header.length,
    ...rows.map((row) => row[column].length),
  ));
  const line = (cells: Array<string>) => cells
    .map((cell, column) => cell.padEnd(widths[column]))
    .join('  ')
    .trimEnd();

  console.log(ansis.gray(line(headers)));
  for (const row of rows) console.log(line(row));
}

export const commandFn: TypedGunshiCommandFn<typeof commandSpec> = async (ctx) => {
  const asJson = Boolean(ctx.values.json);
  const backend = localEncrypt.getBackendInfo();

  if (!backend.biometricAvailable) {
    if (asJson) {
      console.log(JSON.stringify({ sessions: [] }, null, 2));
      return;
    }
    console.log(`The ${backend.type} backend does not hold unlock sessions.`);
    return;
  }

  const sessions = await localEncrypt.listSessions();

  if (asJson) {
    console.log(JSON.stringify({ sessions }, null, 2));
    return;
  }

  if (sessions.length === 0) {
    console.log('No unlock sessions are open.');
    return;
  }

  renderTable(sessions);
  console.log('');
  console.log(ansis.gray('Run `varlock lock --current` to end this terminal\'s session, or `varlock lock` to end all.'));
};
