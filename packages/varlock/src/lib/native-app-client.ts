import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import Debug from 'debug';
import fs from 'node:fs/promises';
import { pathExists } from '@env-spec/utils/fs-utils';
import { createKeyPair } from './apple-crypto';

const debug = Debug('varlock:native-app-client');

const APP_PATH = path.resolve(
  os.homedir(),
  'Library/Containers/dev.dmno.macapp',
);
const IPC_SOCKET_PATH = path.join(APP_PATH, 'Data/dmno-ipc');
const VARLOCK_DIR = path.resolve(os.homedir(), '.varlock');

export class VarlockNativeAppClient {
  private socket: net.Socket;

  private messageQueue: Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>;

  private isInitialized: boolean = false;
  private isConnected: boolean = false;

  private isAppInstalled: boolean = false;
  private isAppRunning: boolean = false;

  constructor(opts?: { }) {
    this.socket = new net.Socket();
    this.messageQueue = new Map();
    this.isConnected = false;
  }


  private generateMessageId(): string {
    // Generate a unique ID using timestamp and random bytes
    const timestamp = Date.now().toString(36); // Base36 timestamp
    const random = crypto.randomBytes(4).toString('hex'); // 8 random hex chars
    return `${timestamp}-${random}`;
  }


  private async init() {
    this.isInitialized = true;
    this.isAppInstalled = await pathExists(APP_PATH);
    if (!this.isAppInstalled) {
      throw new Error('App is not installed!');
    }
    await this.initializeSocket();
  }

  static async initHomeFolderKeypair(githubUsername?: string) {
    if (!await pathExists(VARLOCK_DIR)) await fs.mkdir(VARLOCK_DIR, { recursive: true });

    const identityFile = path.join(VARLOCK_DIR, 'identity.json');

    const newKeyPair = await createKeyPair();
    await fs.writeFile(identityFile, JSON.stringify({
      githubUsername,
      privateKey: newKeyPair.privateKey,
    }));
  }

  initializeSocket() {
    return new Promise((resolve, _reject) => {
      this.socket.on('connect', () => {
        debug('Connected to native app');
        this.isConnected = true;
        resolve(true);
      });

      this.socket.on('data', (data: Buffer) => {
        debug('> received data');
        try {
          // Read message length (4 bytes, little endian)
          const messageLength = data.readUInt32LE(0);
          const messageData = data.slice(4, 4 + messageLength);
          const message = JSON.parse(messageData.toString());

          debug('> message', message);

          // Handle special messages
          if (message.type === '__disconnect') {
            this.cleanup();
            return;
          }

          // Handle response messages
          if (message.id && this.messageQueue.has(message.id)) {
            const { resolve: qResolve } = this.messageQueue.get(message.id)!;
            this.messageQueue.delete(message.id);
            qResolve(message.result);
          } else {
            console.log('Received message without ID:', message);
          }
        } catch (error) {
          console.error('Error processing message:', error);
        }
      });

      this.socket.on('error', (error) => {
        console.error('Socket error:', error);
        // TODO: if error is related to initial connection, reject the promise
        this.cleanup();
      });

      this.socket.on('close', () => {
        debug('socket closed');
        this.isConnected = false;
        this.cleanup();
      });

      this.socket.connect(IPC_SOCKET_PATH);
    });
  }

  private async sendIpcMessage(message: any): Promise<any> {
    if (!this.isInitialized) await this.init();

    return new Promise((resolve, reject) => {
      if (!this.isConnected) {
        reject(new Error('Socket is not connected'));
        return;
      }

      const messageId = this.generateMessageId();
      const messageWithId = {
        ...message,
        id: messageId,
      };

      const jsonData = JSON.stringify(messageWithId);
      const messageBytes = new TextEncoder().encode(jsonData);

      // Create length prefix (4 bytes, little endian)
      const lengthBytes = new Uint8Array(4);
      const view = new DataView(lengthBytes.buffer);
      view.setUint32(0, messageBytes.length, true);

      // Combine length and message
      const combinedBytes = new Uint8Array(4 + messageBytes.length);
      combinedBytes.set(lengthBytes);
      combinedBytes.set(messageBytes, 4);

      // Store promise handlers
      this.messageQueue.set(messageId, { resolve, reject });

      // Send message
      this.socket.write(combinedBytes);
    });
  }

  public async encrypt(plaintext: string): Promise<any> {
    return this.sendIpcMessage({
      action: 'encrypt',
      payload: { plaintext },
    });
  }

  public async decrypt(ciphertext: string): Promise<any> {
    return this.sendIpcMessage({
      action: 'decrypt',
      payload: { ciphertext },
    });
  }

  public cleanup() {
    // Reject all pending messages
    for (const { reject } of this.messageQueue.values()) {
      reject(new Error('Connection closed'));
    }
    this.messageQueue.clear();
    this.socket.end();
  }


  // --------------
  static async isNativeAppInstalled() {
    return await pathExists(APP_PATH);
  }
  static async isNativeAppInstallable() {
    const platform = os.platform();
    // check if darwin = MacOS
    if (platform === 'darwin') {
      // this gets the version of _darwin_ not MacOS
      const releaseMajorVersion = Number((os.release()).split('.')[0]);
      // Darwin v22 = macOS 13 (Ventura)
      // techincally the app is set to have 13.6 the minimum version, but this should be ok
      return releaseMajorVersion >= 22;
    }
    return false;
  }
}


