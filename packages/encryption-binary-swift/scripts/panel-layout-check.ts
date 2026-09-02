/**
 * Holds the approval panel's one layout promise: the action row does not move.
 *
 * The panel's approval controls change size with the answer. `Once` grants
 * narrow and draws no breadth checkbox, so the content above the buttons is a
 * row shorter than it is under every other answer. The old fix was to reserve
 * the row and keep every panel the same total height, which bought a stable
 * button position at the price of a visible band of nothing under `Once`.
 *
 * Equal heights were never the point. What matters is that Deny and the scan
 * control stay where they are, because the sensor is armed the whole time the
 * controls are live and a finger is already on its way. So the panel absorbs the
 * difference above the buttons, and this asserts the property that replaced the
 * old one: the action row sits the same distance above the bottom of the panel
 * in every state, and the window is re-anchored to its bottom edge when the
 * controls change, so that distance is a distance on screen too.
 *
 * The executable target has no test target, so this measures a real render:
 * `panel-preview` draws the same view tree the modal puts on screen and reports
 * where the action row landed in it.
 *
 *   swift build --package-path packages/encryption-binary-swift/swift
 *   bun run packages/encryption-binary-swift/scripts/panel-layout-check.ts
 *
 * Flags:
 *   --keep   leave the rendered PNGs behind, with their paths printed
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const binary = path.resolve(here, '../swift/.build/debug/VarlockEnclave');

if (!fs.existsSync(binary)) {
  throw new Error(`binary not built at ${binary}; run: swift build --package-path packages/encryption-binary-swift/swift`);
}

const keep = process.argv.includes('--keep');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-panel-layout-'));

let failures = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`);
  }
}

/**
 * A request with several values behind one key, which is what gives the panel a
 * breadth choice to draw. Without one there is no checkbox, and the state this
 * is about would not exist.
 */
const request = {
  keyIds: ['varlock-default'],
  itemDigestCounts: { 'varlock-default': 12 },
  display: {
    projectName: 'acme-api',
    projectPath: '/Users/dev/acme-api',
    keys: {
      'varlock-default': {
        valueCount: 24,
        sources: [
          { path: '.env', entries: [{ name: 'DATABASE_URL' }, { name: 'STRIPE_TEST_KEY' }] },
          { path: '.env.local', entries: [{ name: 'OPENAI_API_KEY' }, { name: 'GH_TOKEN' }] },
        ],
      },
    },
  },
};

type Render = { name: string; height: number; actionRowInsetFromBottom: number; path: string };

function render(name: string, payload: Record<string, unknown>): Render {
  const payloadPath = path.join(outDir, `${name}.json`);
  const pngPath = path.join(outDir, `${name}.png`);
  fs.writeFileSync(payloadPath, JSON.stringify({ ...request, ...payload }));
  const result = JSON.parse(execFileSync(
    binary,
    ['panel-preview', '--payload', payloadPath, '--out', pngPath],
    { encoding: 'utf-8' },
  ));
  if (!result.ok) throw new Error(`panel-preview failed for ${name}: ${result.error}`);
  return {
    name,
    height: result.height,
    actionRowInsetFromBottom: result.actionRowInsetFromBottom,
    path: pngPath,
  };
}

console.log('rendering every answer the ladder offers, plus both disclosures open');
// Every scope, the custom rung (which reveals a row of its own for the number
// and the unit toggle), and the same set again with the key box and the chain
// expanded: a disclosure changes the content above the buttons too, and it must
// not move them either.
//
// `custom` is a duration naming no preset, which is exactly what a remembered
// custom answer looks like coming back: the rung opens selected, wearing its
// value, with the field under it.
const CUSTOM_MS = 45 * 60 * 1000;
const renders = [
  render('once', { scope: 'once' }),
  render('duration', { scope: 'duration' }),
  render('custom', { scope: 'duration', durationMs: CUSTOM_MS }),
  render('session', { scope: 'session' }),
  render('once-expanded', { scope: 'once', expandKeys: true, expandChain: true }),
  render('duration-expanded', { scope: 'duration', expandKeys: true, expandChain: true }),
  render('custom-expanded', {
    scope: 'duration',
    durationMs: CUSTOM_MS,
    expandKeys: true,
    expandChain: true,
  }),
  render('session-expanded', { scope: 'session', expandKeys: true, expandChain: true }),
];
for (const one of renders) {
  console.log(`  ${one.name}: height ${one.height}, action row ${one.actionRowInsetFromBottom} above the bottom`);
}

const insets = new Set(renders.map((one) => one.actionRowInsetFromBottom));
check(
  'the action row sits the same distance above the bottom in every state',
  insets.size === 1,
  renders.map((one) => [one.name, one.actionRowInsetFromBottom]),
);

// The other half of the same change: `once` really is shorter now rather than
// padded out to match. A panel that went back to equal heights would be holding
// an empty row open again.
const once = renders.find((one) => one.name === 'once')!;
const session = renders.find((one) => one.name === 'session')!;
const custom = renders.find((one) => one.name === 'custom')!;
const duration = renders.find((one) => one.name === 'duration')!;
check(
  'once draws a shorter panel rather than reserving the hidden checkbox row',
  once.height < session.height,
  { once: once.height, session: session.height },
);

// And the same rule in the other direction, for the row the custom rung
// reveals: the panel GROWS for it rather than everything else reserving space
// against the day somebody picks it.
check(
  'custom draws a taller panel rather than every other answer reserving its row',
  custom.height > duration.height,
  { custom: custom.height, duration: duration.height },
);

// The device-key panel, which has no ladder at all and is the one most easily
// forgotten when the controls above it change. Checked on its own, because its
// content is a different builder and its height has no business matching.
console.log('\nrendering the legacy device-key panel');
const legacy = render('legacy', { legacy: true });
console.log(`  ${legacy.name}: height ${legacy.height}, action row ${legacy.actionRowInsetFromBottom} above the bottom`);
check(
  'the legacy device-key panel keeps the same action row inset',
  legacy.actionRowInsetFromBottom === once.actionRowInsetFromBottom,
  { legacy: legacy.actionRowInsetFromBottom, rest: once.actionRowInsetFromBottom },
);

if (keep) {
  console.log(`\nrenders left in ${outDir}`);
} else {
  fs.rmSync(outDir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
