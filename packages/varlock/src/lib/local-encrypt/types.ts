/**
 * Shared types for the local encryption system.
 */

/** Which encryption backend is active */
export type BackendType = (
  | 'secure-enclave' // macOS Secure Enclave (Swift binary)
  | 'windows-tpm' // Windows TPM via NCrypt (Rust binary)
  | 'linux-tpm' // Linux TPM2 (Rust binary)
  | 'file' // Pure JS file-based (universal fallback)
);

/** Information about the active encryption backend */
export interface BackendInfo {
  type: BackendType;
  platform: NodeJS.Platform;
  hardwareBacked: boolean;
  biometricAvailable: boolean;
  binaryPath?: string;
}

/** IPC daemon message format (length-prefixed JSON over Unix socket or named pipe) */
export interface DaemonMessage {
  id: string;
  action: 'decrypt' | 'encrypt' | 'prompt-secret' | 'ping' | 'invalidate-session';
  payload?: Record<string, unknown>;
}

/** IPC daemon response format */
export interface DaemonResponse {
  id: string;
  result?: unknown;
  error?: string;
}

/** Result from the status command of a native binary */
export interface NativeStatusResult {
  backend: string;
  hardwareBacked: boolean;
  biometricAvailable: boolean;
  keys: Array<string>;
}
