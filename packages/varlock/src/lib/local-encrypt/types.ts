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
// Shapes for the daemon work that follows the identity layer. Nothing wires
// these up yet: they are here so the TS and native sides agree on the protocol
// before either implements it.
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

/** `unlock-session` payload: open a grant so the daemon may hold the identity key */
export interface UnlockSessionRequest extends SessionGrantRef {
  identityId?: string;
  scope: SessionGrantScope;
  /** only meaningful for scope `duration`; clamped to MAX_SESSION_GRANT_MS */
  durationMs?: number;
}

/** A grant as the daemon reports it back (never includes key material) */
export interface SessionGrantInfo extends SessionGrantRef {
  identityId: string;
  scope: SessionGrantScope;
  /** epoch ms */
  grantedAt: number;
  /** epoch ms; always set, since every scope is capped */
  expiresAt: number;
  /** how many decrypts this grant has served */
  useCount: number;
}

export type UnlockSessionResult = SessionGrantInfo;

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
 * `decrypt-v2` payload: decrypt an identity-encrypted payload under a grant.
 *
 * `keyId` is the device key the identity is wrapped to, not the key the payload
 * was encrypted with. Without a live grant the daemon gates on user presence
 * first and, if that passes, serves the decrypt.
 */
export interface DecryptV2Request extends SessionGrantRef {
  ciphertext: string;
  identityId?: string;
}

export interface DecryptV2Result {
  plaintext: string;
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
