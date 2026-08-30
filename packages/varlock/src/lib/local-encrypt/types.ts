/**
 * Shared types for the local encryption system.
 */

/** Which encryption backend is active */
export type BackendType = (
  | 'secure-enclave' // macOS Secure Enclave (Swift binary)
  | 'windows-tpm' // Windows native (Rust binary) — NCrypt TPM seal + Windows Hello presence; DPAPI fallback
  | 'linux-tpm' // Linux native (Rust binary) — TPM2 seal/unseal and/or Secret Service; polkit/PAM presence
  | 'file' // Pure JS file-based (universal fallback)
);

/** Information about the active encryption backend */
export interface BackendInfo {
  type: BackendType;
  platform: NodeJS.Platform;
  hardwareBacked: boolean;
  biometricAvailable: boolean;
  binaryPath?: string;
  /** True when the file backend is being used as a fallback because the native binary was not found */
  isFileFallback?: boolean;
}

/** IPC daemon message format (length-prefixed JSON over Unix socket or named pipe) */
export interface DaemonMessage {
  id: string;
  action: 'decrypt' | 'encrypt' | 'prompt-secret' | 'ping' | 'invalidate-session'
    | 'keychain-get' | 'keychain-search' | 'keychain-pick' | 'keychain-fix-access' | 'keychain-set'
    | IdentityDaemonAction;
  payload?: Record<string, unknown>;
}

/** IPC daemon response format */
export interface DaemonResponse {
  id: string;
  result?: unknown;
  error?: string;
  errorCode?: string;
}

// ── Identity session protocol ──────────────────────────────────────────
//
// Shapes for the identity session ops. The macOS daemon implements these; the
// loader does not call them yet, so these types are what the two sides agree on
// while the client side is built out.
//
// The daemon holds the unwrapped identity private key on behalf of a session,
// so hardware backends can read v2 payloads without the key ever entering this
// process. A grant is what makes that holding legitimate, and it is keyed by
// (sessionId x keyId): the same session unlocking a different key is a separate
// grant, and the same key in a different session is too.

/** Daemon actions added for identity-backed sessions */
export type IdentityDaemonAction = 'unlock-session' | 'list-sessions' | 'decrypt-v2';

/**
 * How long a grant survives.
 *
 * - `once`: a single decrypt, then the grant is spent
 * - `session`: until the session it is bound to ends (or the cap is hit)
 * - `duration`: a caller-chosen window, still bounded by the cap
 */
export type SessionGrantScope = 'once' | 'session' | 'duration';

export const SESSION_GRANT_SCOPES: Array<SessionGrantScope> = ['once', 'session', 'duration'];

/**
 * Hard ceiling on any grant, whatever scope or duration was asked for.
 * A `session` grant on a session that never ends still expires here.
 */
export const MAX_SESSION_GRANT_MS = 12 * 60 * 60 * 1000;

/**
 * Identifies one grant.
 *
 * `sessionId` uses the existing session-scoping identity (controlling TTY, or
 * the process-tree/agent-env fallback), so a grant cannot be borrowed by an
 * unrelated session on the same machine.
 */
export interface SessionGrantRef {
  sessionId: string;
  keyId: string;
}

/**
 * `unlock-session` payload: open a grant so the daemon may hold the identity key.
 *
 * `sessionId` is not sent. The daemon resolves the session from the connecting
 * process itself, so a caller cannot name its way into someone else's session.
 * One unlock covers every key it names, for a single user-presence check.
 */
export interface UnlockSessionRequest {
  keyIds: Array<string>;
  identityId?: string;
  scope: SessionGrantScope;
  /** only meaningful for scope `duration`; clamped to MAX_SESSION_GRANT_MS */
  durationMs?: number;
  /**
   * Which system events end this session. Omit to take the machine config, and
   * then the built-in default. An unrecognized value is reported by the daemon on
   * stderr and ignored, rather than failing the unlock.
   */
  lockOn?: SessionLockPolicy;
}

/**
 * What ends an unlock session, short of its TTL running out.
 *
 * The 12h hard cap and explicit invalidation always apply and are not
 * configurable: this only decides which system events erase a session.
 *
 * - `screenLock`: erased by screen lock and by sleep
 * - `sleep`: erased by sleep; survives the screen locking
 * - `none`: erased only by TTL expiry, the hard cap, or an explicit lock
 */
export type SessionLockPolicy = 'screenLock' | 'sleep' | 'none';

export const SESSION_LOCK_POLICIES: Array<SessionLockPolicy> = ['screenLock', 'sleep', 'none'];

/** Used when neither the session nor the machine config says otherwise */
export const DEFAULT_SESSION_LOCK_POLICY: SessionLockPolicy = 'sleep';

/** Where an effective lock policy came from */
export type SessionLockPolicySource = 'session-override' | 'machine-config' | 'built-in-default';

/**
 * Machine-wide session settings, read by the daemon from the user-level config
 * file (`<user varlock dir>/config.json`, the same file telemetry settings use).
 * Never read from project config: a project must not get to weaken how long this
 * machine holds keys.
 *
 * ```json
 * { "sessions": { "lockOn": "sleep" } }
 * ```
 *
 * The daemon reads it fresh at each unlock, so an edit applies to the next unlock
 * with no restart. A missing file or section is not an error.
 */
export interface UserConfigSessionSettings {
  lockOn?: SessionLockPolicy;
}

/** How the daemon satisfied user presence for an unlock */
export type UnlockPolicy = (
  | 'biometrics'
  | 'device-owner' // Touch ID, Apple Watch, or the device password
  | 'no-presence-required' // key was created with --no-auth (CI)
);

/** A grant as the daemon reports it back (never includes key material) */
export interface SessionGrantInfo extends SessionGrantRef {
  identityId: string;
  scope: SessionGrantScope;
  /** epoch ms */
  grantedAt: number;
  /** epoch ms; always set, since every scope is capped */
  expiresAt: number;
  /** epoch ms of the last decrypt this grant served; absent until first use */
  lastUsedAt?: number;
  /** epoch ms when this session was unlocked */
  sessionUnlockedAt: number;
  /** epoch ms when the session's 12h cap runs out */
  sessionExpiresAt: number;
  /** which system events erase this session, as resolved at unlock time */
  lockOn: SessionLockPolicy;
  /** how long this grant still has, as of when the daemon answered */
  expiresInMs: number;
  /** how many decrypts this grant has served */
  useCount: number;
}

export interface UnlockSessionResult {
  sessionId: string;
  policy: UnlockPolicy;
  /** the effective lock policy for this session */
  lockOn: SessionLockPolicy;
  /** which of the three sources decided it */
  lockOnSource: SessionLockPolicySource;
  grants: Array<SessionGrantInfo>;
}

/** `list-sessions` result: every live grant the daemon is holding */
export interface ListSessionsResult {
  sessions: Array<SessionGrantInfo>;
}

/**
 * `invalidate-session` payload.
 *
 * Omitting both fields drops every grant, which is what today's argument-less
 * `invalidate-session` already does. Naming a session drops that session's
 * grants; naming both drops exactly one grant.
 */
export interface InvalidateSessionRequest {
  sessionId?: string;
  keyId?: string;
}

export interface InvalidateSessionResult {
  /** how many grants were dropped */
  invalidated: number;
}

/**
 * `decrypt-v2` payload: decrypt identity-encrypted payloads under a grant.
 *
 * `keyId` is the device key the identity is wrapped to, not the key the payload
 * was encrypted with. There is no implicit unlock: without a live grant the
 * daemon refuses (`NO_SESSION_GRANT`) and the caller runs `unlock-session`.
 *
 * Payloads come as a batch, since a whole env file resolves at once, and the
 * batch is one grant use: a `once` grant covers the call however many payloads
 * it carried. `sessionId` is not sent; the daemon resolves it from the peer.
 */
export interface DecryptV2Request {
  keyId: string;
  ciphertexts: Array<string>;
  identityId?: string;
}

export interface DecryptV2Result {
  plaintexts: Array<string>;
  /** the grant that served this call, after its use was charged */
  grant: SessionGrantInfo;
}

/** Error codes the daemon attaches to identity session failures */
export type IdentitySessionErrorCode = (
  | 'NO_SESSION_GRANT' // nothing unlocked for this (session x key)
  | 'SESSION_GRANT_EXPIRED' // the grant or its session cap ran out
  | 'SESSION_KEY_MISSING' // daemon no longer holds the key (restarted, or locked)
  | 'NO_SESSION_IDENTITY' // the caller's session could not be identified
  | 'BIOMETRIC_FAILED'
  | 'IDENTITY_NOT_FOUND'
  | 'IDENTITY_MALFORMED'
  | 'IDENTITY_VERSION_UNSUPPORTED'
  | 'IDENTITY_NO_WRAP_FOR_KEY'
);

/**
 * Protocol version this build of varlock expects from the daemon.
 *
 * 1 (reported as an absent `protocolVersion`) is a daemon predating identity
 * sessions. A client that needs the session ops can compare against this to tell
 * a stale daemon from one that speaks them.
 */
export const DAEMON_PROTOCOL_VERSION = 2;

/** `ping` result */
export interface DaemonPingResult {
  pong: boolean;
  /** whether this session already holds a cached biometric context */
  sessionWarm: boolean;
  /** the session identity the daemon resolved for this process, if any */
  sessionId?: string;
  /** absent on daemons older than the identity session ops, which means 1 */
  protocolVersion: number;
}

/** Metadata about a keychain item (no secret values) */
export interface KeychainItemMeta {
  service: string;
  account: string;
  label?: string;
  kind: 'generic' | 'internet';
  keychain?: string;
}

/** Reference to a specific keychain item for lookup */
export interface KeychainItemRef {
  service: string;
  account?: string;
  keychain?: string;
  label?: string;
}

/** Result from adding VarlockEnclave to a keychain item's access list */
export interface KeychainFixAccessResult {
  modified: boolean;
}

/** Result from creating or updating a keychain item */
export interface KeychainSetResult {
  updated: boolean;
}

/** Per-key metadata reported by a native binary */
export interface NativeKeyDetail {
  keyId: string;
  /** Should decrypts of this key require user-presence verification when a gate is available? */
  requireAuth: boolean;
  protection?: string;
  createdAt?: string;
}

/** Result from the status command of a native binary */
export interface NativeStatusResult {
  backend: string;
  hardwareBacked: boolean;
  biometricAvailable: boolean;
  keys: Array<string>;
  /** Present only on binaries that report per-key metadata */
  keyDetails?: Array<NativeKeyDetail>;
}
