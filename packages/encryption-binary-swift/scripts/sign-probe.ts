/**
 * Does a real signing identity change what LocalAuthentication will do for us?
 *
 * Two behaviours on macOS 26 have been blamed on our ad-hoc signature without
 * anyone testing it:
 *
 *   - `LAAuthenticationView` renders blank, so the scan falls back to the
 *     system's own coreautha alert instead of drawing inside our window
 *   - `LARight` custody fails with `errSecMissingEntitlement` (-34018), so an
 *     LARight-held key cannot hold our wrap
 *
 * Bundle identity alone was ruled out earlier (a bundled ad-hoc build behaves the
 * same). The untested variable is a Developer ID signature with the hardened
 * runtime, and entitlements on top of it. This signs the same binary several
 * ways and runs the machine-checkable probes against each, so the question stops
 * being a hypothesis.
 *
 * The research checklist for "LAAuthenticationView renders blank" is asserted
 * rather than assumed: the framework being linked, the view having real area and
 * being in a visible key window before the evaluation, a fresh context, and the
 * evaluated context being the one the view was built around. Each is reported
 * per variant, so the only unexplained difference between a working and a
 * non-working row is the signature.
 *
 * What it does NOT do is decide whether the inline view draws. There is no
 * reliable signal for that (see the README), so the last step arms a real panel
 * from the best variant and asks a person to look.
 *
 * Everything happens in a fresh temp directory and a scratch XDG_CONFIG_HOME, so
 * it is re-runnable and touches nothing of the user's except the keychain access
 * codesign itself needs.
 *
 *   swift build --package-path packages/encryption-binary-swift/swift
 *   bun run packages/encryption-binary-swift/scripts/sign-probe.ts
 *
 * Flags:
 *   --identity "<name>"   use this signing identity instead of the discovered one
 *   --keep                leave the temp bundles behind for inspection
 *   --no-visual           stop after the table, skip the panel presentation
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..');
const builtBinary = path.join(packageRoot, 'swift', '.build', 'debug', 'VarlockEnclave');

const BUNDLE_ID = 'dev.varlock.enclave';
const PROBE_KEY_ID = 'varlock-sign-probe';
/** Long enough for the system to draw whatever it is going to draw, short enough to sit through. */
const PROBE_TIMEOUT_SECONDS = 6;
/** With somebody watching, long enough to look properly and answer or scan. */
const INTERACTIVE_TIMEOUT_SECONDS = 30;

function getArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (!fs.existsSync(builtBinary)) {
  throw new Error(`binary not built at ${builtBinary}; run: swift build --package-path packages/encryption-binary-swift/swift`);
}

/** Whether a person is here to answer the question a machine cannot. */
const interactive = !process.argv.includes('--yes') && !process.argv.includes('--no-visual');

/**
 * Ask the watcher something, and wait.
 *
 * Rendering has no machine signal, so the only way this experiment produces an
 * answer at all is by asking. One variant at a time, advanced by a keypress,
 * because a run that fires four prompts in a row teaches nobody which was which.
 */
async function ask(question: string): Promise<string> {
  if (!interactive) return '';
  process.stdout.write(question);
  return new Promise<string>((resolve) => {
    const onData = (chunk: Buffer) => {
      process.stdin.pause();
      process.stdin.off('data', onData);
      resolve(chunk.toString().trim().toLowerCase());
    };
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

/** y / n / anything else, for a question only eyes can answer. */
async function askRendered(label: string): Promise<string> {
  if (!interactive) return 'not-asked';
  const answer = await ask(`  did the Touch ID prompt draw INSIDE the ${label} window? [y/n/?] `);
  if (answer.startsWith('y')) return 'inline';
  if (answer.startsWith('n')) return 'system-alert';
  return 'unclear';
}

type Run = { ok: boolean; stdout: string; stderr: string; failure?: string };

function run(command: string, args: Array<string>, env?: NodeJS.ProcessEnv): Run {
  const result = spawnSync(command, args, {
    encoding: 'utf-8',
    env: env ?? process.env,
  });
  const stdout = result.stdout ?? '';
  // Kept even on success: codesign reports its facts on stderr and exits 0.
  const stderr = (result.stderr ?? '').trim();
  if (result.status === 0) return { ok: true, stdout, stderr };

  // A binary the kernel refuses to launch says nothing on stderr at all: it is
  // killed before it runs. That is the shape of an entitlement with no
  // provisioning profile behind it, and reporting it as an empty error would
  // hide the most interesting result this experiment can produce.
  const failure = result.signal
    ? `killed by ${result.signal} on launch, with no output: the usual cause is an entitlement `
      + 'the system will not grant without a provisioning profile'
    : `exit ${result.status}${stderr ? `: ${stderr.split('\n')[0]}` : ' with no output'}`;
  return {
    ok: false, stdout, stderr, failure,
  };
}

// ── the signing identity ────────────────────────────────────────

/**
 * What this machine can sign with.
 *
 * Prints everything it found before choosing, because "it picked the wrong
 * certificate" is otherwise an invisible way for this whole experiment to be
 * wrong.
 */
function discoverIdentity(): { name: string; teamId?: string } {
  const explicit = getArg('--identity');
  const listed = run('security', ['find-identity', '-v', '-p', 'codesigning']).stdout;
  console.log('signing identities on this machine:');
  console.log(listed.trim().split('\n').map((line) => `  ${line.trim()}`).join('\n'));

  const identities = [...listed.matchAll(/^\s*\d+\)\s+[0-9A-F]+\s+"([^"]+)"/gm)].map((m) => m[1]);
  const chosen = explicit
    ?? identities.find((name) => name.startsWith('Developer ID Application'))
    ?? identities[0];
  if (!chosen) {
    throw new Error('no codesigning identity found; a Developer ID Application certificate is what this tests');
  }
  const teamId = chosen.match(/\(([A-Z0-9]{10})\)\s*$/)?.[1];
  console.log(`\nusing identity: ${chosen}${teamId ? ` (team ${teamId})` : ' (no team id in the name)'}`);
  return { name: chosen, teamId };
}

/**
 * A Developer ID provisioning profile, if the developer has one.
 *
 * Restricted entitlements (`com.apple.application-identifier`, keychain access
 * groups outside the team prefix) are only honoured when the bundle carries a
 * profile that grants them. Without one they are signed in and ignored, which
 * looks exactly like "the entitlement did not help".
 */
function findProvisioningProfile(): string | undefined {
  const directories = [
    path.join(os.homedir(), 'Library', 'MobileDevice', 'Provisioning Profiles'),
    path.join(os.homedir(), 'Library', 'Developer', 'Xcode', 'UserData', 'Provisioning Profiles'),
  ];
  for (const directory of directories) {
    if (!fs.existsSync(directory)) continue;
    const profile = fs.readdirSync(directory).find((name) => name.endsWith('.provisionprofile'));
    if (profile) return path.join(directory, profile);
  }
  return undefined;
}

// ── the bundle ──────────────────────────────────────────────────

const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-sign-probe-'));

function assembleBundle(variantId: string): string {
  const appDir = path.join(scratchRoot, variantId, 'VarlockEnclave.app');
  const macosDir = path.join(appDir, 'Contents', 'MacOS');
  fs.mkdirSync(macosDir, { recursive: true });
  fs.copyFileSync(builtBinary, path.join(macosDir, 'VarlockEnclave'));
  fs.chmodSync(path.join(macosDir, 'VarlockEnclave'), 0o755);
  fs.writeFileSync(path.join(appDir, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key>
    <string>${BUNDLE_ID}</string>
    <key>CFBundleName</key>
    <string>Varlock</string>
    <key>CFBundleDisplayName</key>
    <string>Varlock</string>
    <key>CFBundleExecutable</key>
    <string>VarlockEnclave</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleVersion</key>
    <string>0.0.0</string>
    <key>CFBundleShortVersionString</key>
    <string>0.0.0</string>
    <key>LSUIElement</key>
    <true/>
</dict>
</plist>
`);
  return appDir;
}

function writeEntitlements(variantId: string, entries: Record<string, string | Array<string> | boolean>): string {
  const body = Object.entries(entries).map(([key, value]) => {
    if (typeof value === 'boolean') return `    <key>${key}</key>\n    <${value}/>`;
    if (Array.isArray(value)) {
      const items = value.map((item) => `        <string>${item}</string>`).join('\n');
      return `    <key>${key}</key>\n    <array>\n${items}\n    </array>`;
    }
    return `    <key>${key}</key>\n    <string>${value}</string>`;
  }).join('\n');
  const filePath = path.join(scratchRoot, variantId, 'entitlements.plist');
  fs.writeFileSync(filePath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${body}
</dict>
</plist>
`);
  return filePath;
}

// ── the probes ──────────────────────────────────────────────────

type Checklist = {
  embeddedUiLinked?: boolean;
  viewReadyBeforeEvaluate?: boolean;
  viewFrame?: string;
  viewAlpha?: number;
  viewHidden?: boolean;
  windowVisibleAndKey?: boolean;
  freshContext?: boolean;
  sameContextAsView?: boolean;
  canEvaluate?: boolean;
  canEvaluateError?: string;
  evaluateErrorCode?: number;
  evaluateErrorDomain?: string;
  signatureValid?: boolean;
  hardenedRuntime?: boolean;
  screenScanPermitted?: boolean;
  activationPolicy?: string;
};

type EmbeddedRun = {
  policy: 'regular' | 'accessory';
  verdict: string;
  authAgentWindows: string;
  inlineDrew?: boolean;
  /** What the watcher saw: inline, system-alert, unclear, or not-asked. */
  rendered: string;
  checklist: Checklist;
};

type ProbeResult = {
  custodyVerdict: string;
  custodyStatus: string;
  embedded: Array<EmbeddedRun>;
  notes: Array<string>;
};

/**
 * Run both machine-checkable probes from inside the signed bundle.
 *
 * A scratch config home per variant, and a real presence-gated key made by the
 * signed binary itself: a key created by one code identity is not evidence about
 * another.
 */
async function runProbes(appDir: string, variant: Variant): Promise<ProbeResult> {
  const variantId = variant.id;
  const notes: Array<string> = [];
  const executable = path.join(appDir, 'Contents', 'MacOS', 'VarlockEnclave');
  const configHome = path.join(scratchRoot, variantId, 'config');
  fs.mkdirSync(path.join(configHome, 'varlock', 'secure-enclave'), { recursive: true });
  // Skip the one-time setup panel: it is real and wanted, and it is not what
  // this experiment is about.
  fs.writeFileSync(path.join(configHome, 'varlock', 'secure-enclave', '.setup-shown'), '');
  const env = { ...process.env, XDG_CONFIG_HOME: configHome };

  const generated = run(executable, ['generate-key', '--key-id', PROBE_KEY_ID], env);
  if (!generated.ok) {
    notes.push(`this build does not run: ${generated.failure ?? generated.stderr.slice(0, 200)}`);
    return {
      custodyVerdict: 'not-run', custodyStatus: '-', embedded: [], notes,
    };
  }

  // Question 2: can an LARight-held key take custody, or is it still -34018?
  const custody = run(executable, ['probe-laright', '--custody-only', '--timeout', '5'], env);
  let custodyVerdict = 'error';
  let custodyStatus = '-';
  try {
    const parsed = JSON.parse(custody.stdout);
    custodyVerdict = parsed.verdict ?? 'unknown';
    const error = parsed.custody?.error as string | undefined;
    custodyStatus = error?.match(/(-\d{4,6})/)?.[1] ?? (parsed.custody?.saved ? 'saved' : '-');
    if (error) notes.push(`custody: ${error.slice(0, 120)}`);
  } catch {
    notes.push(`custody probe did not return JSON: ${(custody.stderr || custody.stdout).slice(0, 160)}`);
  }

  // Question 1, the half a machine can answer: when the evaluation fires, does
  // the system draw its own coreautha alert? Nobody has to answer it; the probe
  // times out on its own.
  //
  // Run twice, because the probe has always been a `.regular` app and the daemon
  // is an `.accessory` one. If the inline view behaves differently between them
  // then the activation policy is the variable, not the certificate, and this is
  // the cheapest place to find that out.
  const embedded: Array<EmbeddedRun> = [];
  for (const policy of ['regular', 'accessory'] as const) {
    const label = `${variantId} / ${policy}`;
    if (interactive) {
      console.log(`\n  next: ${label}  (${variant.label})`);
      await ask('  press Enter to open that probe window ');
    }
    const result = run(
      executable,
      [
        'probe-embedded-unlock',
        '--key-id',
        PROBE_KEY_ID,
        '--timeout',
        String(interactive ? INTERACTIVE_TIMEOUT_SECONDS : PROBE_TIMEOUT_SECONDS),
      ],
      {
        ...env,
        _VARLOCK_PROBE_ACTIVATION: policy,
        // The window says which run it is, in its title and across its top.
        _VARLOCK_PROBE_LABEL: `${label}: ${variant.label}`,
      },
    );
    const rendered = await askRendered(label);
    try {
      const parsed = JSON.parse(result.stdout);
      const seen = parsed.authAgentWindowsSeen;
      embedded.push({
        policy,
        verdict: parsed.verdict ?? 'unknown',
        authAgentWindows: Array.isArray(seen) ? (seen.join(',') || 'none') : String(seen ?? '-'),
        inlineDrew: parsed.inlineViewDrewSomething,
        rendered,
        checklist: (parsed.checklist ?? {}) as Checklist,
      });
      if (parsed.reason) notes.push(`embedded (${policy}): ${String(parsed.reason).slice(0, 110)}`);
    } catch {
      embedded.push({
        policy, verdict: 'error', authAgentWindows: '-', rendered, checklist: {},
      });
      notes.push(`embedded (${policy}) returned no JSON: ${(result.failure ?? result.stderr ?? '').slice(0, 140)}`);
    }
  }

  run(executable, ['delete-key', '--key-id', PROBE_KEY_ID], env);
  return {
    custodyVerdict, custodyStatus, embedded, notes,
  };
}

// ── the matrix ──────────────────────────────────────────────────

type Variant = {
  id: string;
  label: string;
  entitlements?: Record<string, string | Array<string> | boolean>;
  needsProfile?: boolean;
  /// Signed with `-`, which is what every development build has been so far.
  adHoc?: boolean;
};

const identity = discoverIdentity();
const teamId = identity.teamId ?? 'TEAMID';
const profile = findProvisioningProfile();
console.log(profile
  ? `provisioning profile found: ${profile}`
  : 'no provisioning profile found (the profile variant will say so rather than guessing)');

const variants: Array<Variant> = [
  {
    // The control. Without it, "the inline view drew" is a fact about the probe
    // rather than a fact about the signature.
    id: '0-adhoc',
    label: 'ad-hoc signature, bundled the same way (the control)',
    adHoc: true,
  },
  {
    id: 'a-hardened',
    label: 'Developer ID + hardened runtime, no entitlements',
  },
  {
    id: 'b-entitlements',
    label: 'a + keychain-access-groups and application-identifier',
    entitlements: {
      'keychain-access-groups': [`${teamId}.${BUNDLE_ID}`],
      'com.apple.application-identifier': `${teamId}.${BUNDLE_ID}`,
      'com.apple.developer.team-identifier': teamId,
    },
  },
  {
    id: 'c-profile',
    label: 'b + embedded provisioning profile',
    entitlements: {
      'keychain-access-groups': [`${teamId}.${BUNDLE_ID}`],
      'com.apple.application-identifier': `${teamId}.${BUNDLE_ID}`,
      'com.apple.developer.team-identifier': teamId,
    },
    needsProfile: true,
  },
];

type VariantOutcome = {
  variant: Variant;
  appDir?: string;
  signed: boolean;
  signError?: string;
  codesignFlags?: string;
  probes?: ProbeResult;
  skipped?: string;
};

const outcomes: Array<VariantOutcome> = [];

for (const variant of variants) {
  console.log(`\n── ${variant.id}: ${variant.label} ─────────────────────`);

  if (variant.needsProfile && !profile) {
    console.log('  skipped: no .provisionprofile on this machine.');
    console.log('  Restricted entitlements need a Developer ID provisioning profile from the');
    console.log('  developer portal (Certificates, Identifiers & Profiles), downloaded and');
    console.log('  placed in ~/Library/MobileDevice/Provisioning Profiles/.');
    outcomes.push({ variant, signed: false, skipped: 'no provisioning profile available' });
    continue;
  }

  const appDir = assembleBundle(variant.id);
  if (variant.needsProfile && profile) {
    fs.copyFileSync(profile, path.join(appDir, 'Contents', 'embedded.provisionprofile'));
    console.log(`  embedded profile: ${path.basename(profile)}`);
  }

  const args = ['--force', '--timestamp=none'];
  // The hardened runtime is not available to an ad-hoc signature, and asking for
  // it would make the control fail to sign rather than fail to work.
  if (!variant.adHoc) args.push('--options', 'runtime');
  if (variant.entitlements) {
    args.push('--entitlements', writeEntitlements(variant.id, variant.entitlements));
  }
  args.push('--sign', variant.adHoc ? '-' : identity.name, appDir);

  const signed = run('codesign', args);
  if (!signed.ok) {
    // A rejected entitlement is a result, not a crash: record exactly what
    // codesign said and keep going.
    console.log(`  codesign FAILED: ${signed.failure ?? signed.stderr.split('\n')[0]}`);
    outcomes.push({
      variant, appDir, signed: false, signError: signed.stderr.split('\n').slice(0, 3).join(' | '),
    });
    continue;
  }

  const details = run('codesign', ['-dv', '--verbose=4', appDir]);
  const flags = details.stderr.match(/flags=([^\s]+)/)?.[1] ?? '?';
  const signedEntitlements = run('codesign', ['-d', '--entitlements', '-', '--xml', appDir]).stdout;
  console.log(`  signed. flags=${flags}`);
  if (variant.entitlements) {
    const kept = Object.keys(variant.entitlements).filter((key) => signedEntitlements.includes(key));
    console.log(`  entitlements that survived signing: ${kept.length ? kept.join(', ') : 'none'}`);
  }

  if (!interactive) console.log('  running probes (a Touch ID sheet may appear; nobody has to answer it)');
  const probes = await runProbes(appDir, variant);
  outcomes.push({
    variant, appDir, signed: true, codesignFlags: flags, probes,
  });
}

// ── the table ───────────────────────────────────────────────────

function pad(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : text + ' '.repeat(width - text.length);
}

function yesNo(value: boolean | undefined): string {
  if (value === undefined) return '-';
  return value ? 'yes' : 'no';
}

console.log('\n\n== variant matrix =========================================================');
console.log([
  pad('variant', 16),
  pad('app policy', 11),
  pad('signed', 7),
  pad('LARight custody', 17),
  pad('status', 8),
  pad('embedded verdict', 22),
  'coreautha windows',
].join(' '));

for (const outcome of outcomes) {
  const runs = outcome.probes?.embedded.length
    ? outcome.probes.embedded
    : [
      {
        policy: '-' as const, verdict: '-', authAgentWindows: '-', checklist: {}, inlineDrew: undefined,
      },
    ];
  const signedLabel = outcome.signed ? 'yes' : 'no';
  const custodyLabel = outcome.probes?.custodyVerdict ?? outcome.skipped ?? 'n/a';
  for (const [index, embeddedRun] of runs.entries()) {
    // Variant-wide facts on the first of its rows only, so the eye reads down
    // the policy column rather than across repeated text.
    const firstRow = index === 0;
    console.log([
      pad(firstRow ? outcome.variant.id : '', 16),
      pad(embeddedRun.policy, 11),
      pad(firstRow ? signedLabel : '', 7),
      pad(firstRow ? custodyLabel : '', 17),
      pad(firstRow ? (outcome.probes?.custodyStatus ?? '-') : '', 8),
      pad(embeddedRun.verdict, 22),
      embeddedRun.authAgentWindows,
    ].join(' '));
  }
}

for (const outcome of outcomes) {
  const lines = [
    outcome.signError ? `codesign: ${outcome.signError}` : undefined,
    ...(outcome.probes?.notes ?? []),
  ].filter(Boolean);
  if (!lines.length) continue;
  console.log(`\n${outcome.variant.id}:`);
  for (const line of lines) console.log(`  ${line}`);
}

// The checklist: every stock explanation for a blank inline view, answered.
console.log('\n== conditions asserted per variant =========================================');
const conditions: Array<[string, (c: Checklist) => string]> = [
  ['EmbeddedUI linked', (c) => yesNo(c.embeddedUiLinked)],
  ['view ready pre-eval', (c) => yesNo(c.viewReadyBeforeEvaluate)],
  ['view frame', (c) => c.viewFrame ?? '-'],
  ['view alpha / hidden', (c) => `${c.viewAlpha ?? '-'} / ${yesNo(c.viewHidden)}`],
  ['window visible+key', (c) => yesNo(c.windowVisibleAndKey)],
  ['fresh LAContext', (c) => yesNo(c.freshContext)],
  ['same ctx as view', (c) => yesNo(c.sameContextAsView)],
  ['canEvaluatePolicy', (c) => yesNo(c.canEvaluate)],
  ['canEvaluate error', (c) => (c.canEvaluateError ?? '-').slice(0, 22)],
  ['LAError on evaluate', (c) => (c.evaluateErrorCode ? `${c.evaluateErrorCode} (${c.evaluateErrorDomain ?? ''})` : 'none')],
  ['signed / hardened', (c) => `${yesNo(c.signatureValid)} / ${yesNo(c.hardenedRuntime)}`],
  ['window scan allowed', (c) => yesNo(c.screenScanPermitted)],
  ['activation policy', (c) => c.activationPolicy ?? '-'],
];
const ran = outcomes.flatMap((outcome) => (outcome.probes?.embedded ?? []).map((embeddedRun) => ({
  label: `${outcome.variant.id}/${embeddedRun.policy}`,
  embeddedRun,
})));
if (ran.length) {
  console.log([pad('condition', 22), ...ran.map((entry) => pad(entry.label, 22))].join(' '));
  for (const [label, read] of conditions) {
    console.log([
      pad(label, 22),
      ...ran.map((entry) => pad(read(entry.embeddedRun.checklist), 22)),
    ].join(' '));
  }
  console.log([
    pad('inline view drew', 22),
    ...ran.map((entry) => pad(yesNo(entry.embeddedRun.inlineDrew), 22)),
  ].join(' '));
  console.log([
    pad('coreautha seen', 22),
    ...ran.map((entry) => pad(entry.embeddedRun.authAgentWindows, 22)),
  ].join(' '));
}

console.log('\nHow to read this:');
console.log('  LARight custody "custody-available" (rather than custody-refused / -34018) means');
console.log('  the entitlement gate moved, and an LARight-held key could hold our wrap.');
console.log('  "coreautha windows" naming an auth agent means the system drew its own alert while');
console.log('  the evaluation was live, which is the fallback we are trying to get away from.');
console.log('  Every condition above answered the same way across variants means the signature is');
console.log('  the only thing that differs, so any change in behaviour belongs to it. A condition');
console.log('  answered "no" anywhere is a bug in the probe setup, not evidence about signing.');
console.log('');
console.log('Two columns cannot be trusted on their own, which is why the eyes step exists:');
console.log('  "inline view drew" counts subviews and layer content, which the view has whether or');
console.log('  not it renders anything a person can see.');
console.log('  "coreautha windows" can only ever be empty without screen-recording permission');
console.log('  ("window scan allowed" says whether it was granted), so empty is "cannot tell".');

// ── the part only a person can answer ───────────────────────────

/// A real signature wins a tie: it is the variant worth looking at, and the
/// ad-hoc row is only here as the control.
function score(outcome: VariantOutcome): number {
  return (outcome.probes?.custodyVerdict === 'custody-available' ? 4 : 0)
    + (outcome.probes?.embedded.some((embeddedRun) => embeddedRun.verdict === 'embedded-handoff-ok') ? 2 : 0)
    + (outcome.variant.adHoc ? 0 : 1);
}

if (process.argv.includes('--no-visual')) {
  const kept = outcomes.filter((outcome) => outcome.signed).sort((a, b) => score(b) - score(a))[0];
  console.log(`\nSkipping the eyes step. The best-signed bundle is at:\n  ${kept?.appDir ?? '<none signed>'}`);
} else {
  // The visual check runs the PROBE window, not the shipping panel.
  //
  // The panel stopped embedding `LAAuthenticationView` months ago (it drew
  // nothing and the system alert appeared anyway), so looking at the panel can
  // only ever show the system sheet and would answer nothing. The probe window
  // is the one that still binds the view, so it is the only place where "does
  // the inline prompt draw when properly signed" is a question at all.
  const best = outcomes.filter((outcome) => outcome.signed && outcome.probes?.embedded.length)
    .sort((a, b) => score(b) - score(a))[0];

  if (!best?.appDir) {
    console.log('\nNothing signed ran, so there is nothing to look at. Fix the identity and re-run.');
  } else {
    console.log(`\n\n== the eyes step (${best.variant.id}) ======================================`);
    console.log('Rendering has no reliable signal (see the table caveats), so this part is eyes only.');
    console.log('A probe window is about to open with the scan armed. What to look for:');
    console.log('  - a Touch ID prompt drawn INSIDE the probe window = the inline view works here');
    console.log('  - a separate system alert on top of it = it does not, whatever the signature says');
    console.log('Scan or let it time out; either way the probe reports and exits.\n');

    const configHome = path.join(scratchRoot, best.variant.id, 'eyes-config');
    fs.mkdirSync(path.join(configHome, 'varlock', 'secure-enclave'), { recursive: true });
    fs.writeFileSync(path.join(configHome, 'varlock', 'secure-enclave', '.setup-shown'), '');
    const env = { ...process.env, XDG_CONFIG_HOME: configHome };
    const executable = path.join(best.appDir, 'Contents', 'MacOS', 'VarlockEnclave');
    run(executable, ['generate-key', '--key-id', PROBE_KEY_ID], env);

    const watched = spawnSync(
      executable,
      ['probe-embedded-unlock', '--key-id', PROBE_KEY_ID, '--verbose', '--timeout', '45'],
      { env, stdio: ['ignore', 'inherit', 'inherit'], encoding: 'utf-8' },
    );
    console.log(`\nprobe exited ${watched.status ?? watched.signal}`);
    run(executable, ['delete-key', '--key-id', PROBE_KEY_ID], env);

    console.log('\nTo run the control (same binary, same window, ad-hoc signature):');
    const control = outcomes.find((outcome) => outcome.variant.adHoc)?.appDir;
    console.log(`  XDG_CONFIG_HOME=$(mktemp -d) ${control ?? '<ad-hoc bundle>'}/Contents/MacOS/VarlockEnclave \\`);
    console.log('    probe-embedded-unlock --key-id varlock-sign-probe --timeout 45');
    console.log('  (re-run this script with --keep to hold on to both bundles)');
  }
}

if (process.argv.includes('--keep')) {
  console.log(`\nbundles kept at ${scratchRoot}`);
} else {
  fs.rmSync(scratchRoot, { recursive: true, force: true });
  console.log('\ncleaned up the temp bundles (pass --keep to inspect them)');
}
