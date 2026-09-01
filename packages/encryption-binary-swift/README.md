# @varlock/encryption-binary-swift

macOS native binary for varlock's local encryption, built in Swift.

This package is the build system only and is not published. The built binary ships to npm through the [`@varlock/native-helper-darwin`](../native-helpers/darwin/) publishing shell (see [`packages/native-helpers/`](../native-helpers/)), and is bundled directly into the standalone CLI archives.

## Why Swift?

Varlock uses the **Secure Enclave** for hardware-backed key storage on macOS. The Secure Enclave, Touch ID biometric prompts, and native UI (status bar menu, secure input dialogs) are only accessible through Apple's `Security`, `LocalAuthentication`, and `AppKit` frameworks — which are designed for Swift/Objective-C. Rust or other languages would require fragile FFI bindings with no stable C ABI to target.

The `.app` bundle format is also required for custom Touch ID icons, `LSUIElement` (menu-bar-only) behavior, and proper code signing + notarization.

Rust is planned for Windows (TPM / Windows Hello) and Linux (TPM2), where the platform APIs have C-friendly interfaces. The IPC protocol (length-prefixed JSON over a Unix socket) is the same across all platforms.

## Keychain Integration

The binary includes a `keychain()` resolver that reads secrets from the macOS Keychain. This is useful for IT-managed environments where credentials are pushed to user keychains via MDM.

- **Search & read** — uses modern `SecItemCopyMatching` API (not deprecated)
- **Create items** — stores as Keychain secure notes via `SecItemAdd` (not deprecated), with plain text values
- **ACL management** — uses legacy `SecKeychainItemCopyAccess` / `SecTrustedApplicationCreateFromPath` / `SecKeychainItemSetAccess` APIs to add VarlockEnclave to an item's trusted application list

### Note on deprecated SecKeychain ACL APIs

The ACL management APIs (`SecKeychainItemCopyAccess`, `SecACLCopyContents`, `SecACLSetContents`, `SecTrustedApplicationCreateFromPath`, `SecKeychainItemSetAccess`) were deprecated in macOS 10.10 (2014) when Apple introduced the "Data Protection Keychain." Apple's modern keychain controls access via entitlements and access groups set at build time — there is no runtime API to grant another app access to a keychain item.

For our use case (programmatically granting VarlockEnclave access to items created by other apps, e.g. IT-managed credentials), the legacy APIs are the only option. Every password manager and security tool that does this uses the same deprecated APIs. Apple has kept them functional through macOS 15+ because there is no replacement.

These APIs are only used in the "select existing item" picker flow when VarlockEnclave doesn't already have access. Items created by VarlockEnclave itself (via "Create New") don't need ACL modification.

## Identity unlock sessions

Values can be encrypted to an identity key rather than straight to the device key
(see `packages/varlock/src/lib/local-encrypt/identity.ts`). The identity private key
is ECIES-wrapped to the device key, and only the daemon may unwrap it. Two enclave
keys are involved:

- the **custody key** is the existing biometric device key. It holds the wrap at rest,
  so opening a session always costs one user-presence check.
- the **session key** is created per unlock with `.privateKeyUsage` only (no presence).
  It exists solely in daemon memory: no `.keydata` file is written. At unlock the
  identity key is unwrapped once through the custody key and immediately re-wrapped
  under the session key, and only that blob is kept. Later decrypts unwrap it silently.

Ending a session scrubs the session key data, which crypto-erases every blob held under
it. Nothing is persisted, so a daemon restart loses all sessions on purpose: a
session-wrapped blob on disk plus a no-presence key would reopen silently after a
reboot, defeating the biometric gate. A restart just means the next use costs one scan.

Daemon actions (IPC protocol version 3, reported by `ping`):

| action | what it does |
| --- | --- |
| `unlock-session` | one approval and one presence check, however many key ids; records grants and returns them |
| `decrypt-v2` | decrypts a batch of v2 payloads under a live grant, no prompt |
| `list-sessions` | live grants: scope, granted keys, unlock time, remaining TTL |
| `invalidate-session` | no arguments drops everything; `sessionId` drops one session; both fields drop one grant |
| `request-approval` | asks a yes/no question on the panel and reports the answer; no key operation attached |

Grants are keyed by (session x key), where the session comes from `SessionScoping`.
Scopes are `once`, `session`, and `duration`, and everything is capped at 12h from the
session's first unlock.

A malformed message is refused rather than guessed at. `unlock-session` answers
`Missing payload` when there is no payload, and `NO_KEYS_REQUESTED` when it names no
key: there is no default key, because opening one the caller never asked for would
hand it a grant it did not request. Both `keyIds` and the singular `keyId` are
accepted, and blank entries are dropped before that check.

Every deadline is recorded twice: once in wall-clock time, which is what `expiresAt`
reports and what a person reads, and once on `CLOCK_MONOTONIC_RAW`, which no clock
change can move. Whichever runs out first ends the grant, so setting the system clock
backwards cannot extend a session, and the cap still holds across a suspend because the
raw monotonic clock keeps counting while the machine sleeps. `expiresInMs` comes from
that pair rather than from the wall clock.

### What ends a session

Beyond the TTL and the 12h cap, a `lockOn` policy decides which system events erase a
session:

| value | erased by |
| --- | --- |
| `screenLock` | screen lock and sleep |
| `sleep` | sleep only; survives the screen locking (default) |
| `none` | nothing but TTL expiry, the hard cap, or an explicit lock |

Resolution order is per-session override, then machine config, then the built-in
default of `sleep`:

- **per-session**: `unlock-session` takes an optional `lockOn`. It is stored on the
  session, and the lock observers consult each session's own policy, so a `screenLock`
  session can be erased by the same event a `none` session in the same daemon survives.
  Re-unlocking a session is how it changes its policy.
- **machine config**: `sessions.lockOn` in the user-level config file varlock already
  keeps at `<user varlock dir>/config.json` (the same file telemetry settings use):

  ```json
  { "sessions": { "lockOn": "sleep" } }
  ```

  Read fresh at each unlock, so an edit applies to the next unlock with no restart.
  Machine-level only, never project config: a project must not get to weaken how long
  this machine holds keys. A missing file or section is not an error. A value that is
  present and unrecognized is reported on stderr and skipped, falling through to the
  next source rather than failing the unlock.

The 12h hard cap is not configurable, and an explicit lock (`invalidate-session` with no
arguments, or the menu bar Lock All) always erases everything whatever the policy says.
Which macOS notification counts as which event: only `willSleepNotification` is `sleep`;
display sleep and fast user switching are `screenLock`, so a display that sleeps after a
couple of idle minutes does not read as the machine sleeping.

The machine default is also editable from the menu bar, under "Lock Sessions On". That
writes the same `sessions.lockOn` field, keeping every other key in the file.

## The menu bar

The status item is the passive indicator: a closed lock when the daemon holds nothing,
an open one while any session is unlocked, with the session count next to it once there
is more than one. Both are SF Symbols templates, so they follow the menu bar's own
appearance.

The menu is rebuilt each time it opens, and nothing in it ticks. Times are coarse for
that reason: "9h left" is still true an hour later, where a countdown would be wrong the
moment it was drawn.

| item | what it does |
| --- | --- |
| one submenu per session | the terminal or process it belongs to, the keys it holds with scope and time left, how much of the 12h limit is left, and what will end it |
| Lock This Session | inside a session's submenu; drops that session's grants and nothing else |
| Lock All | erases every session and every cached biometric context, whatever their policy |
| Lock Sessions On | the machine default for new sessions: Screen lock, Sleep, or Only manually |
| Quit Daemon | stops the daemon, which also erases everything |

Per-session policies are shown on their rows but are not editable there. A session's
policy was settled when the user approved its unlock, and re-unlocking is how it
changes; a menu that quietly rewrote it would be changing a decision after the fact.

What the wording says is decided in `SessionMenuModel`, which has no AppKit in it and is
unit tested, so `StatusBarMenu` is only the translation into `NSMenuItem`s.

## The authorization log

Before `decrypt-v2` unwraps anything, the daemon appends a line to
`<user varlock dir>/audit/authorizations.jsonl` (0600, in a 0700 directory), flushes it
with `fsync`, and reads it back off the disk. If any of that fails the decrypt is refused
with `AUDIT_WRITE_FAILED` and no plaintext is produced. Unlocks are recorded the same way
and hand their keys straight back if the record fails, so the daemon never holds a
session that nothing says was opened.

```json
{"event":"decrypt-v2","identityId":"default","keyIds":["varlock-default"],"payloadCount":12,"requester":"node ← claude ← zsh (ttys004)","scope":"session","sessionId":"tty:ttys004:1756...","ts":"2026-08-30T15:42:22.881Z"}
```

Invalidations are recorded too, but best effort: refusing to erase key material because a
log line would not write is the wrong way round, so those are reported on stderr and the
erase goes ahead.

Records hold identifiers, counts, and a description of the calling process. No plaintext,
no ciphertext, and no key material ever goes in, which is what makes the file safe to read
and to hand to someone else.

## Peer posture

Beyond checking the connecting process's binary name, the daemon asks the kernel two
things about it: whether a debugger or tracer is attached (`CS_DEBUGGED` or `P_TRACED`),
and whether it is running with the Hardened Runtime (`CS_RUNTIME`). Each check has its own
stderr line and its own error code, `PEER_DEBUGGER_ATTACHED` and
`PEER_HARDENED_RUNTIME_MISSING`, with `PEER_POSTURE_UNREADABLE` when the status word
cannot be read at all.

How hard they bite depends on the daemon's own code signature, read the same way, since a
daemon that is not hardened itself is in no position to demand it of anyone:

| daemon | debugger attached | no Hardened Runtime |
| --- | --- | --- |
| development (`swift build`, ad-hoc signed) | reported | reported |
| signed release | rejected | reported |
| `sessions.peerPosture: "strict"` | rejected | rejected |
| `sessions.peerPosture: "warn"` | reported | reported |

The hardening check only reports by default, even in release, because the processes that
legitimately connect are frequently not hardened: the standalone `varlock` binary is
ad-hoc signed by `bun build --compile`, and Homebrew's node and bun are ad-hoc signed too.
Turn it into a rejection here once the release pipeline signs the CLI with
`--options runtime`. Until then, anyone whose clients are all official builds can have it
today with `strict`.

## The approval panel

A gated key raises a panel before anything else happens. The daemon draws it,
because the daemon is the process that verified the peer and holds the keys, so it
is the only party that can say truthfully who is asking.

The panel arms the presence check as soon as it is on screen and frontmost, so
**the scan is the approval**: the common case costs one gesture, with no separate
confirm click. The sensor is live about a fifth of a second after the panel
lands, which the arming check asserts.

That wait used to be most of a second, for a reason that no longer applies:
arming summoned the system's own sheet, which covered the panel, so the delay was
the only thing standing between a user and approving something they never got to
read. The scan happens inside the panel now, so there is nothing to occlude and
nothing to wait for beyond the window finishing its appearance
(`ApprovalPanel.armingDelaySeconds`).

**Setting Touch ID up is not approving anything.** The first time varlock uses
the sensor on a machine, and again after the enrolled fingerprints change, macOS
wants an interaction of its own. That happens first, alone, with nothing drawn
behind it and with wording that says what it is ("varlock is setting up Touch ID
approvals"). Its context is thrown away, so it cannot stand in for an approval.
The panel comes after, and its scan is the one that unlocks. First run therefore
costs two scans, on purpose. What has been set up is recorded next to the key
store (`.biometric-setup.json`, a hash of the enrolment), and
`_VARLOCK_BIOMETRIC_SETUP=0`/`1` overrides the decision if it ever misjudges a
machine.

**The panel arms itself once, ever.** If the system sheet is dismissed, that is
not a refusal and not a failure: the panel stays up, unarmed, and says "Touch ID
canceled. Click Approve to scan again". Nothing re-presents the sheet without a
click. Choosing "Enter Password" inside the sheet moves the panel onto the
password path and waits for that click too.

The panel is a window the daemon draws itself, not an `NSAlert`: the layout is the
message, and an alert can hold text and buttons and nothing else. **The scan
happens inside it.** `LAAuthenticationView`, bound to the context this approval
will run under, sits on its own line above the buttons; touching the sensor is the
approval and no system alert appears over the top of it.

That view was written off once. An earlier arc concluded it rendered blank on
macOS 26 and shipped a drawn glyph plus the system's alert instead. Two
experiments settled it properly, and both are in `scripts/`:

- `sign-probe.ts` signs the same binary several ways (ad-hoc, Developer ID with
  the hardened runtime, and with entitlements) and runs the machine-checkable
  probes against each. The view rendered in every variant, so the signature was
  never the problem. It also established that entitlements the system will not
  grant without a provisioning profile make the build unlaunchable (SIGKILL with
  no output), and that `LARight` custody stays `-34018` whatever we sign with.
- `render-bisect.ts` then walked from the probe (which rendered) to the panel
  (which did not), flipping one axis at a time and **measuring pixels** rather
  than asking anyone: `WindowPixels` photographs the view's own area and counts
  distinct greys, so a blank square and a drawn fingerprint are different numbers.

The axis that flipped it was how the panel is presented from the IPC thread:

| panel presented via | distinct greys |
| --- | --- |
| `DispatchQueue.main.sync` | 1 (blank) |
| `RunLoop.main.perform` | 51 (drawn) |

The daemon answers IPC on a background queue, and the panel used to be drawn from
inside a main-QUEUE work item that stays in flight for as long as the modal is up.
LocalAuthentication needs the main queue to render into the view it was bound to,
and a blocked main queue starves it. Worse than blank: a bound view suppresses the
system alert, so nothing anywhere asks for a finger. That is the same starvation
that once stopped the check from arming, which is why `MainLoop` exists; the
presentation itself was the last place still doing it the old way.

The fallback is still there for machines that cannot embed (no biometrics
enrolled, or the sensor locked out) and for `_VARLOCK_EMBEDDED_PROMPT=0`, and it
is the only path that raises a system dialog.

The panel shows, top to bottom:

- a **top bar**: the varlock mark, and one standing fact about approvals (what
  ends a session and its 12h cap, or that unlocks are recorded).
- a **heading**: which keys, and which project asked. `varlock-default` is called
  `local encryption` here; its id is an implementation detail nobody should have
  to read off a panel.
- the **key box**: one row per key, with the vault it belongs to and how many
  values it covers. A row opens to the value names, grouped by the file that
  defined them, under a line saying they were reported by the client. A client
  that sent no value names gets a row with no chevron that does not respond to a
  click, because an affordance that opens nothing is a lie. They were:
  the daemon has no way to know what an env value is called, and does not lend its
  credibility to a string a caller sent. None of it is bound into the crypto.
- the **execution chain**: the line of processes leading to the caller, read off
  the peer. The app that was launched sits at the top with its icon and the tty
  it hosts ("iTerm2 · ttys004"), and the plumbing folds into "N more steps" on a
  long chain. Without a launcher at the top (tmux, or a walk that ran out of
  depth) the tty label goes to the topmost hop that really is on that tty, rather
  than to whatever process happened to come first.

  One row can be **emphasised**, and it means one thing: the ACTOR, the program
  the secrets are being loaded for. A script beats the interpreter running it
  (`agent.ts`, not `bun`); a host that auto-loaded varlock (`next dev`, `vite`, a
  test runner) is the actor because varlock ran on its behalf. varlock itself
  never is: it is in every chain, so emphasising it would say nothing about this
  request. Shells never are, since `zsh` is how a command was typed rather than
  what it was typed for. The session root never is, having a treatment of its
  own. When nothing qualifies, nothing is bold, which is the honest state for a
  command a person typed: the values are for that command, and the command is
  varlock. A bold row that always exists is a bold row that means nothing. Opening that shows each hop's path,
  the word for its code-signing posture, and the command line varlock itself was
  invoked with, read from the kernel's own copy of its argv rather than from
  anything the client sent. What a mark means is said under the hop it belongs to
  ("a script run by bun: approval trusts this file, not the signed interpreter"),
  never in a legend at the bottom that a reader would have to match back up to a
  row. varlock's own hop is named plainly: `bunx varlock load` shows as `varlock`
  and not as "varlock via bun", since bun is how varlock ships rather than who is
  asking, and its command line reads as it was typed (`$ varlock load`). When
  varlock was loaded by a host process instead of run by a person, the line says
  so and names the host's command (`auto-loaded inside next dev`): the mode is
  client-reported, the command is the kernel's.

  Colour on the chain means exactly one thing at a time. Green is a signature we
  checked, amber is a script whose source is mutable, purple is a coding-agent
  session, and the emphasised actor is marked in bright neutral rather than in an
  accent colour: a coloured marker sitting next to a green dot reads as a verdict
  on the process, and that marker is about structure. Red is not used here at
  all, so it stays available for posture that is actually bad.
- the **session root**: the hop a "this session" grant actually attaches to,
  drawn as a tinted row tagged "session root" at the place it really sits in the
  ancestry. Every chain has exactly one, because every grant has one. The panel
  offers "This session" as a scope, and a session nobody can point at is a
  promise nobody can check. The hop comes from `SessionScoper.sessionAnchor`,
  the same code that computes the identifier the grant is keyed by, so the row a
  person reads and the identity they are granting to cannot drift apart. Usually
  that is the outermost shell on the controlling terminal, drawn as "zsh" with
  "Terminal ttys004" under it, which is the name the menu bar lists that session
  under and the name ending it will use. With no terminal it is the stable
  process-tree ancestor the scoper picks. A coding-agent session is DECORATION on
  that row, applied when the agent turns out to be the anchoring process: the row
  then carries the product, the session's own title, and when it started. The
  title comes from the agent's own on-disk record, matched to the process by pid
  and checked against its start time so a recycled pid cannot put somebody else's
  session on the panel. No uuid is ever shown. The rail below the row is tinted
  to match, so every process inside the session is a span you can see rather than
  a relationship you have to work out, and that hop is never folded away. When
  the walk stopped before reaching the anchor (an app bundle at the top, the
  depth cap, the deadline) the mark goes on the topmost hop the chain does have,
  which is the nearest thing to the anchor that was actually read.
- **for how long**: this session (the default), once, or a set time (1, 4, 8, or
  12 hours). The longest window on offer is the 12h cap itself, so a choice can
  never be one the grant table would quietly clip. Selecting a segment changes
  its colour and nothing else: a heavier selected label was a wider one, and the
  control used to shift by a few points every time the user changed their mind.
- the **actions**: Deny, red with a stop mark, and the approve control beside it.
  On a machine that can scan, that control IS the sensor: the system's own Touch
  ID view, at the `small` control size (which is the 32pt one it actually draws,
  rather than a 128pt one squeezed), with "Approve with Touch ID" beside it.
  Touching the sensor approves, and clicking the words approves too. Nothing is
  drawn behind it, and that is not a taste decision: `render-bisect.ts` measured
  every arrangement, and any paint of ours behind the sensor blanks it (a layer
  fill and a `draw(_:)` fill both go to 4 distinct greys), so the mock's solid
  blue bar is not available at all, and the outline that stood in for it read as
  neither a button nor a scan. Machines with no usable sensor get the plain blue
  button, which is also what the panel switches to for the password path. On a
  machine with no usable sensor the approve button is the password path itself
  and there is no link offering it separately.
- **the password path is a password.** Where there is a sensor, "Use password..."
  moves this same approval onto the device-password check, and puts a password
  field on screen with no fingerprint step in front of it. That takes a detour.
  `evaluatePolicy(.deviceOwnerAuthentication)` is the only policy that accepts a
  password, and on a Mac with an enrolled sensor Apple documents it as drawing
  the Touch ID sheet first, with the password behind that sheet's "Use
  Password..." button: a finger asked of someone who has just said "not my
  finger". No policy skips it. `evaluateAccessControl` does: an access control
  constrained to `.devicePasscode` cannot be satisfied by biometry, so the system
  goes straight to the field (measured on macOS 26.1). The context it hands back
  is authenticated for device-owner presence, which is what the custody key's
  `.userPresence` gate accepts; if a machine ever disagrees, the unlock asks
  again through the policy rather than failing on a password the user did give.

Reading the chain is best effort and bounded by a deadline
(`ExecutionChainBuilder`): a process that exits mid-walk, a signature that cannot
be checked, a session record that cannot be read, or a slow machine costs the
panel a detail, never its appearance.

Icons follow the same rule (`PanelIcons`). A hop whose binary lives in an `.app`
gets that app's real icon, an agent session gets the agent's app icon where it is
installed, and a tool with no bundle to ask (bun, node, deno, python) gets a small
tile carrying its initial. Shells and anything unrecognised get the terminal
symbol. None of it is resolved on the path that draws the panel: every icon starts
as the generic mark and is filled in from the run loop, because a picture is never
worth delaying an approval for. Dropping a real icon at
`Contents/Resources/tool-icons/<executable>.png` in the app bundle overrides the
tile without a code change.

Client-supplied context (project name and path, value names, vault labels) only
ever changes the wording. It can never change which keys are unlocked, which
scopes are offered, or whether a prompt happens at all.

Nothing is modal over the panel while the prompt is armed, so the scope controls
stay live and **the scan approves whatever is selected at the moment the finger
lands**. Pick "Once", then scan, and you get Once.

A scan that does not complete is not a refusal. The panel stays exactly as it was,
with a line saying what happened and a "Try again" button that arms the prompt
again. Nothing re-arms on its own, so a failing sensor cannot become a loop, and a
refusal is always something the user pressed.

A second unlock in the same session asks only about what is new ("Also unlock
prod?"), and asks nothing at all when every key requested is already covered by a
live grant.

When biometrics are unavailable, not enrolled, or locked out after too many
failures, there is nothing to embed. The panel falls back to its confirm button
raising the standard system dialog under `deviceOwnerAuthentication`, which still
accepts the device password. That fallback stays button-driven rather than arming
itself, since it is the shape this flow already had in the field. An ungated key
keeps the plain button flow, and shows no panel at all unless a prompt was forced.
`_VARLOCK_EMBEDDED_PROMPT=0` forces the fallback on a machine that could embed.

Every path to a secret goes through this panel. The device-key format that
predates unlock sessions used to authenticate on its own, which on macOS is the
system sheet with nothing behind it: no statement of who was asking or what they
wanted, and after a lock it read as the machine demanding a fingerprint out of
nowhere. That path now draws the same panel. The only presence check that ever
happens without it is the setup step above, which says what it is.

Two answers other than yes:

- **`APPROVAL_DENIED`**: the user was asked and said no.
- **`NO_UI`**: there is no window server to ask on (an SSH session, a headless
  runner). The daemon refuses rather than skipping the question, and the client is
  expected to say so in the terminal.

### Keys that ask every time

A key created with `--auth-every-time` never receives a lasting grant. The panel
offers `once` alone for it, and every later batch of decrypts asks again. In a
mixed batch its row is marked "asks every time", and it takes a `once` grant no
matter which scope the rest of the batch was approved for.

The policy is recorded next to the key, in `<key store>/<keyId>.policy.json`, which
`generate-key` now always writes. It carries two separate things: `authMode`, which
is this policy, and `requireAuth`, which records whether the key was created with
`--no-auth` and so carries no presence gate at all. The second cannot be read back
off a stored enclave key, so the file is the only record of it, and `status` reports
both per key in `keyDetails` for the TypeScript side to route on.

A key with no such file, which is anything created before the file existed, reads as
gated and normal. That includes keys made with `--no-auth` back then: they keep the
routing they always had until they are regenerated, which is the safe way to be wrong.

### `request-approval`

The same panel with a different subject: a title, some description lines, the
scopes it may offer, and optionally `requireBiometric` to add a presence check
after the approve click. Nothing is unlocked and nothing is recorded, so the caller
(the proxy) keeps its own account of what it may do. It answers
`{ decision, scope, durationMs? }`, where a denial is a normal result rather than
an error.

### First run

The first time a gated key is created on a machine, `generate-key` shows a short
"Setting up biometrics for varlock" panel before the key exists, so the first Touch
ID prompt a user ever sees has been introduced. It is informational, appears once
ever (tracked by a marker file next to the key store), is skipped for `--no-auth`
keys and on machines that already have keys, and closes itself after 20 seconds so
an unattended run cannot hang.

### Seeing the panel

`scripts/demo-panel.ts` puts the real panel on screen, one state at a time,
against a scratch config home and ungated keys. No fingerprint is needed: the
keys have no gate and the prompt is forced, so approving will not scan. The point
is the layout and the copy.

```bash
swift build --package-path swift
bun run scripts/demo-panel.ts               # every state in turn
bun run scripts/demo-panel.ts --only agent  # just one
```

The states are `single` (one key, value names behind its row), `two` (a second
key in a team vault), `agent` (the same request sent by a script run by bun,
inside something that looks like an agent session, which is what the execution
chain is there to show), and `delta` (a second key while the session already
holds one). The agent state re-runs the demo as a child process on purpose: the
chain is read off whoever connects, so a faked one would prove nothing.

For a still picture of a state, including ones that need hardware you do not
have, `panel-preview` renders the same view tree to a PNG without asking anyone
anything. Nothing is unlocked and no key is touched:

```bash
./swift/.build/debug/VarlockEnclave panel-preview --payload state.json --out /tmp/panel.png
```

The payload is an `unlock-session` payload (`keyIds`, `display`, `lockOn`) plus
four fields only the preview understands: `mode` (`embedded`, `systemDialog`, or
`none`), `strictKeyIds`, `coveredKeyIds` for the delta state, and `expandChain`
to draw the chain opened, since a picture has nobody to click its expander.

The panel is also what `varlock load` shows against a gated key, which is the
better final check: it exercises the same path a user actually meets.

`scripts/e2e-panel-arming.ts` covers the part a person cannot see, which is that the
presence check is actually armed. Run it first; if it fails, the panel is inert and
there is no point looking at it:

```bash
swift build --package-path swift
bun run scripts/e2e-panel-arming.ts
```

It creates a real gated key, so a Touch ID prompt appears for a moment. Nobody needs
to answer it.

The first run on a machine with no keys yet has its own sequence worth watching once:
the "Setting up biometrics" panel appears first (Continue, or it closes itself after
20 seconds), and then the unlock panel must come to the front. If the system draws
its own authentication alert over the panel that is fine, but when that alert closes
the unlock panel has to be the thing in front, with its controls live.

What to check by hand:

- **there is a Touch ID glyph in the panel** (ours, the system's, or the system's
  drawn over ours) and never an empty square
- **the glyph breathes while the sensor is armed**, and sits still and dim
  whenever it is not. A pulsing glyph is a promise that a finger will be read, so
  it must never be doing that in the button-driven modes, or after a failed scan
  before Try again is pressed
- **a failed scan shakes the glyph**, then leaves it still next to Try again
- **an approval turns the glyph green with a small pop** and holds a moment before
  the panel closes, so the unlock reads as finished rather than as the window
  vanishing
- with Reduce Motion on (System Settings, Accessibility, Display) **nothing moves**:
  the same four states are carried by colour and strength alone, and armed is still
  distinguishable from idle
- **scanning approves the unlock** with no second gesture, whether the prompt is
  inside the panel or in a separate system alert
- the chain names the process and the terminal you are actually typing in, and
  the expander opens the folded hops with their paths and signatures
- "This session" is preselected; clicking "For a set time" opens the duration
  menu, and clicking that segment again reopens it. The label follows the choice
  ("For 4 hours"), and `list-sessions` reports a `duration` grant with the window
  that was picked
- **nothing moves when you toggle scopes**: the three segments keep the same
  size whichever one is selected
- **the scan approves the selected scope**: pick "Once" first, then scan, and
  `list-sessions` reports a `once` grant rather than a session one
- cancelling the scan leaves the panel up with its controls live and a "Try again"
  button, and is NOT reported as a denial
- Cancel comes back as `APPROVAL_DENIED`, and nothing is listed by `list-sessions`
- approving, then asking for the same key again, shows no second panel
- asking for a second key shows the "also unlock" wording and lists only that key
- a key made with `--auth-every-time` offers `once` alone and asks again next batch

To check the refusing path without a screen, run the daemon with
`_VARLOCK_UI_MODE=headless`. Adding `_VARLOCK_FORCE_UNLOCK_PROMPT=1` makes even an
ungated key take the approval path, which is how the end-to-end script covers
`NO_UI`. Both variables only ever make the daemon stricter.

### Seeing the menu

The wording and grouping are unit tested, but the menu itself needs a person and a menu
bar. Run the daemon from the same scratch setup as the panel check, unlock something from
two different terminals, and open it.

What to check by hand:

- the icon is a closed lock before any unlock, and an open one after, with a "2" beside it
  once two terminals have unlocked
- each session's submenu names the terminal you actually unlocked from, and the key rows
  read like `varlock-default: this session, 11h left`
- "Lock This Session" on one of them leaves the other listed and still able to decrypt
- "Lock All" empties the list and puts the closed lock back
- "Lock Sessions On" starts with a checkmark on Sleep, and choosing another writes
  `sessions.lockOn` into `$XDG_CONFIG_HOME/varlock/config.json` without disturbing
  anything else in that file. Add an `anonymousId` to it first and check it survives
- with a `config.json` that is not valid JSON, choosing a policy says so in an alert and
  leaves the file alone
- the times do not tick while the menu is open, and are right again the next time it is
  opened

### Checking the single-scan unlock

The design depends on the daemon driving the biometric itself with
`LAContext.evaluatePolicy` and then handing that authenticated context to the enclave
operation, so the custody unwrap does not raise a second sheet. That is a claim about
a given machine and OS version, so it has a probe:

```bash
swift build --package-path swift
./swift/.build/debug/VarlockEnclave probe-session-unlock --key-id varlock-default
```

It needs a real Mac with enrolled biometrics and asks for exactly one scan. Nobody has
to count sheets: `LAContext.interactionNotAllowed` makes any operation that still wants
UI fail instead of showing it, so a second prompt shows up as a failed phase.

- `control-unauthenticated` must FAIL ("User interaction required"), which is what
  proves the key is presence gated and the detection works
- `handoff-unwrap-1` / `handoff-unwrap-2` must SUCCEED, proving one scan covers
  several enclave operations
- `session-key-silent-unwrap` must SUCCEED with no authentication at all

A `"verdict": "single-scan"` means the handoff holds. `"double-prompt"` means it does
not, and sessions would have to keep their key across soft locks with a daemon-enforced
re-auth instead of crypto-erasing. Verified `single-scan` on macOS 26.1 (Apple silicon).

To create a throwaway key rather than probing a real one:

```bash
./swift/.build/debug/VarlockEnclave generate-key --key-id varlock-probe-session
./swift/.build/debug/VarlockEnclave probe-session-unlock --key-id varlock-probe-session
./swift/.build/debug/VarlockEnclave delete-key --key-id varlock-probe-session
```

### Checking the embedded prompt handoff

`probe-session-unlock` settles that question for `evaluatePolicy` and its floating
system dialog. The panel arms an `LAAuthenticationView` instead, so the scan happens
inside our own window, and the same handoff has to hold for a context authenticated
that way. It is the assumption the one-gesture design rests on: if it did not hold,
an unlock would cost a scan in the panel and then a second prompt from the enclave,
which is worse than what it replaced. So it gets its own probe:

```bash
swift build --package-path swift
./swift/.build/debug/VarlockEnclave generate-key --key-id varlock-probe-embedded
./swift/.build/debug/VarlockEnclave probe-embedded-unlock --key-id varlock-probe-embedded
./swift/.build/debug/VarlockEnclave delete-key --key-id varlock-probe-embedded
```

It opens a small window with the inline prompt in it and asks for exactly one scan.
`"verdict": "embedded-single-scan"` means a context authenticated through the
embedded view still opens the custody key with no further UI, which is what the
panel depends on. `"embedded-handoff-lost"` means it does not, and the panel would
have to go back to raising the system dialog.

Verified `embedded-handoff-ok` on macOS 26.1 (Apple silicon, Touch ID), both from
an unsigned `swift build` binary with no bundle identifier and from the signed
`.app` bundle: one scan, then two custody unwraps under `interactionNotAllowed`
with no second prompt.

That verdict is only about the handoff. It says nothing about where the prompt was
drawn, which is a separate question the probe cannot answer; see below.

`--verbose` streams a timestamped lifecycle log to stderr, and the same log is in
the JSON either way. `--timeout <seconds>` shortens the wait. The log is the thing
to send when the prompt does not arm: it records `canEvaluatePolicy` and the
biometry type, whether the view is bound to the same context that gets evaluated,
the view's intrinsic and actual size, whether the window was key and the app
active, the exact moment `evaluatePolicy` was invoked, and its completion verbatim.
A heartbeat every two seconds adds the view's subview and layer counts, which is
how a prompt that is waiting for a finger can be told from one that never engaged.

The one thing a program cannot check is that no separate dialog appeared. That is
what the person running it confirms: the Touch ID prompt should be inside the probe
window, with nothing else popping up.

### Which prompt actually appears

`LAAuthenticationView` is documented to render the prompt inline, in the view it is
bound to, rather than raising the standard alert. On this machine it does not. What
was observed by eye on macOS 26.1, from a `swift build` binary and again in the real
`varlock load` panel, is that the bound view stays **blank** and macOS presents its
own redesigned biometric alert as a separate window, where the scan happens.

Two earlier failures are fixed and were real, but neither was the cause of that:

- `evaluatePolicy` was being called before `NSApplication.run()`, so the evaluation
  started with no run loop pumping. Both the probe and the panel now evaluate from
  inside the running loop.
- the view reports no intrinsic size on either axis (`-1`), so a stack view is free
  to collapse it to nothing. Both now pin it to a real size.

**Detecting which presentation happened is unreliable.** Checking whether the bound
view drew anything of its own is a false positive: it builds internal layers and
subviews whether or not it presents, so it reported "inline" during a run that was
watched presenting a separate alert. Scanning on-screen windows for an
authentication agent is better but not dependable: it listed nothing during one run
that visibly presented an alert, and correctly caught `coreautha` during another.
The probe logs both as raw observations. Treat a positive window sighting as real
evidence and its absence as no evidence, and remember that only a person looking at
the screen can settle it.

Presentation also appears to be **nondeterministic**: across rounds the same build
has produced the standard alert on some runs and nothing at all on others.

Because of that, the panel does not depend on the answer. It draws its own Touch ID
glyph, with the system's view layered on top: if the system renders inline, its
animation covers ours; if it stays blank, ours shows through. The panel reads as a
self-contained prompt in the first case and as the details card accompanying the
system alert in the second.

`_VARLOCK_EMBEDDED_PROMPT=0` on the daemon skips the inline view entirely and goes
back to the system dialog raised by the panel's own button. No blank area, one extra
gesture, and the check is never weakened.

#### The panel must arm from the run loop, not the main queue

The daemon reaches the panel from a background IPC thread, so it draws the panel
inside a `DispatchQueue.main.sync` work item and then spins a nested modal loop
there. The main queue is serial: anything posted to it with
`DispatchQueue.main.async` cannot run until that enclosing item returns, which does
not happen while the panel is up. The panel kept drawing, so it looked fine, while
the block that starts the Touch ID evaluation, the 120s timeout, and the
evaluation's own completion handler all sat in the queue unreached.

That is why a panel could appear with a fingerprint glyph, a dead sensor, and no
system prompt anywhere: nothing was ever armed, and a bound `LAAuthenticationView`
suppresses the standard alert while its evaluation is not running. The probe never
hit it, because it owns its run loop through `NSApplication.run()`.

Everything the panel schedules now goes through `MainLoop`, which posts run-loop
blocks and timers in the common and modal-panel modes rather than main-queue items.
`scripts/e2e-panel-arming.ts` asserts the arming happens, so this cannot regress
quietly.

#### LARight does not appear to change the answer either

WWDC22's "Streamline local authorization flows" presents `LARight` as the API whose
system-driven UI renders inside the application window, so it was worth a spike:
`probe-laright` drives `LARight.authorize` with an `LAAuthenticationView` on screen
to watch. On macOS 26.1, unsigned dev build, one run recorded:

```
authorize-completed authAgentWindows=coreautha error=<none> state=2 inlineViewDrewSomething=false
```

The authorization succeeded, our view drew nothing, and the system authentication
agent had a window on screen. That is the standard alert again, not an inline
prompt.

The custody half is blocked earlier still. A persisted right is what owns a key, and
creating one fails here:

```
custody-save-failed error=... (OSStatus error -34018 ...)
```

`-34018` is `errSecMissingEntitlement`: `LARightStore` needs a keychain access group
entitlement the current build does not carry. So an `LARight`-backed custody key is
not a small change. It would need entitlement work before the interesting question
(whether `LAPrivateKey.exchangeKeys` can serve our ECIES unwrap, which the headers
say it should) can even be asked on this machine.

Worth knowing for whoever picks this up: the pieces do line up on paper.
`LAPersistedRight.key` is a Secure Enclave `LAPrivateKey`, and it advertises
`exchangeKeys(publicKey:algorithm:parameters:)` with
`kSecKeyAlgorithmECDHKeyExchangeCofactorX963SHA256`, which is exactly the ECDH our
wrap format performs. Migration would also be cheap in this architecture: an
identity can carry more than one wrap, so a right-backed key can be added as an
extra wrap and the old one retired later, with no stored value re-encrypted.

#### Bundle identity is not the explanation

The obvious suspect was process identity, since a bare `swift build` binary has no
bundle identifier and some system UI behaves differently for one. It does not hold
up:

- the probe was run from the signed `.app` bundle (`dev.varlock.enclave.dev`,
  Developer ID, hardened runtime) and behaved the same as the bare binary
- every macOS distribution shape already ships that bundle. The npm helper
  publishes `/VarlockEnclave.app`, the standalone CLI archives copy the same bundle
  in, and the resolver looks for `VarlockEnclave.app`. So `varlock load` already
  runs bundled, and the blank affordance was seen there too

There is therefore no packaging change to chase: production is bundled today, and
being bundled does not appear to change the presentation.

### End-to-end check (no human needed)

`scripts/e2e-identity-session.ts` drives the whole protocol over the real socket
against a throwaway `XDG_CONFIG_HOME`. Its custody key is created with `--no-auth`, so
the unlock finds no presence requirement and never prompts. It also starts a second
daemon that cannot draw anything, and checks that every path needing approval
answers `NO_UI` there instead of proceeding.

It covers the authorization log as well (written, growing, holding no secrets, and
denying decrypts and unlocks while it cannot be written), and restarts the daemon
mid-run to prove that no grant survives it, which is the memory-only promise the design
rests on:

```bash
swift build --package-path swift
bun run scripts/e2e-identity-session.ts
```

It needs a Mac with a Secure Enclave, so it is a local check rather than a CI one.

## Structure

- `swift/` — Swift Package Manager project (`VarlockEnclave` executable)
- `swift/Sources/IdentitySessions/`: ECIES wire format, the grant table and its deadlines, the approval decision logic (what to ask, which scopes to offer, what the panel says), the menu bar's wording, the authorization log writer, and the peer posture policy, in a library target so all of it is unit tested with no window server
- `swift/Sources/SessionScoping/`: process inspection: session identity, the requester description the panel and the log use, and the code-signing facts behind the posture checks
- `scripts/build-swift.ts` — Two-phase build: compile (cacheable) + bundle (mode-specific `.app` wrapping + codesign)
- `scripts/generate-ecies-fixture.ts`: regenerates the cross-implementation ECIES vector the Swift tests pin
- `scripts/e2e-identity-session.ts`: headless end-to-end run of the identity session actions
- `resources/` — App icon and other bundle resources

## Building

```bash
# Local dev (current arch, dev mode)
bun run build:current

# Universal binary (arm64 + x86_64, for CI)
bun run build:universal

# With signing and release metadata
bun run build:universal -- --mode release --version 1.2.3 --sign "Developer ID Application: ..."
```

Output: `packages/varlock/native-bins/darwin/VarlockEnclave.app`
