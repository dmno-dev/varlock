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
    | 'describe-caller';
  payload?: Record<string, unknown>;
}

/**
 * Code-signing facts about one process in a caller chain (macOS daemon only).
 * `kind` is strongest first: apple-platform, developer-id, apple-issued,
 * untrusted-certificate, ad-hoc, unsigned, invalid.
 */
export interface CallerSigningInfo {
  kind: 'apple-platform' | 'developer-id' | 'apple-issued' | 'untrusted-certificate' | 'ad-hoc' | 'unsigned' | 'invalid';
  identifier?: string;
  teamId?: string;
  /** Leaf certificate summary, e.g. "Developer ID Application: DMNO Inc (BPHZUT9PGB)" */
  signerName?: string;
  hardenedRuntime: boolean;
  /** Developer ID signed by varlock's team with a varlock identifier */
  isVarlock: boolean;
}

/** One process in the chain of callers the daemon sees, direct peer first */
export interface CallerProcess {
  pid: number;
  path?: string;
  name?: string;
  /** missing when the daemon could not inspect the process */
  signing?: CallerSigningInfo;
  /**
   * True only for the direct peer, identified by the socket's audit token.
   * Ancestors are looked up by pid (which can be reused), so treat them as
   * display-only.
   */
  verifiedByAuditToken: boolean;
}

/** IPC daemon response format */
export interface DaemonResponse {
  id: string;
  result?: unknown;
  error?: string;
  errorCode?: string;
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

/** Result from the status command of a native binary */
export interface NativeStatusResult {
  backend: string;
  hardwareBacked: boolean;
  biometricAvailable: boolean;
  keys: Array<string>;
}
