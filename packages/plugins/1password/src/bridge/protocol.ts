export const BRIDGE_PROTOCOL_VERSION = 1;

export interface BridgeRequest {
  v: typeof BRIDGE_PROTOCOL_VERSION;
  /** Shared-secret token. Required when the bridge was started with a token. */
  token?: string;
  argv: Array<string>;
  env: Record<string, string | undefined>;
  input?: string;
}

export interface BridgeResponse {
  v: typeof BRIDGE_PROTOCOL_VERSION;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  error?: string;
}

export const BRIDGE_SOCKET_ENV_VAR = 'VARLOCK_OP_BRIDGE_SOCKET';
export const BRIDGE_TOKEN_ENV_VAR = 'VARLOCK_OP_BRIDGE_TOKEN';
export const BRIDGE_TOKEN_FILE_ENV_VAR = 'VARLOCK_OP_BRIDGE_TOKEN_FILE';
