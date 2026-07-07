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
    | 'keychain-get' | 'keychain-search' | 'keychain-pick' | 'keychain-fix-access' | 'keychain-set';
  payload?: Record<string, unknown>;
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

/** Per-key metadata reported by a native binary (status / list-keys) */
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
  /** Present on binaries that support per-key metadata (older binaries omit it) */
  keyDetails?: Array<NativeKeyDetail>;
}
