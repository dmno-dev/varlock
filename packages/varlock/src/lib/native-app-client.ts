/* eslint-disable no-console */

import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import { createDebug } from './debug';

const debug = createDebug('varlock:native-app-client');

// const MAC_APP_PATH = 'Library/Containers/dev.dmno.macapp';
// const IPC_SOCKET_FILE_PATH = 'Data/dmno-ipc';

export class VarlockNativeAppClient {
  private socket: net.Socket;

  private messageQueue: Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>;

  private isInitialized: boolean = false;
  private isConnected: boolean;
  private socketPath: string;

  constructor(opts?: { socketPath?: string }) {
    this.socket = new net.Socket();
    this.messageQueue = new Map();
    this.isConnected = false;
    this.socketPath = opts?.socketPath ?? path.resolve(
      os.homedir(),
      'Library/Containers/dev.dmno.macapp/Data/dmno-ipc',
    );
  }

  private generateMessageId(): string {
    // Generate a unique ID using timestamp and random bytes
    const timestamp = Date.now().toString(36); // Base36 timestamp
    const random = crypto.randomBytes(4).toString('hex'); // 8 random hex chars
    return `${timestamp}-${random}`;
  }

  initializeSocket() {
    this.isInitialized = true;

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

      this.socket.connect(this.socketPath);
    });
  }

  private sendMessage(message: any): Promise<any> {
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
    if (!this.isInitialized) await this.initializeSocket();
    return this.sendMessage({
      action: 'encrypt',
      payload: { plaintext },
    });
  }

  public async decrypt(ciphertext: string): Promise<any> {
    if (!this.isInitialized) await this.initializeSocket();
    return this.sendMessage({
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
}

// // Example usage:
// async function main() {
//   const client = new VarlockNativeAppClient();

//   try {
//     await client.initializeSocket();

//     // Send multiple messages
//     const encryptedHello = await client.encrypt('hello world');
//     console.log('Encrypted data:', encryptedHello);

//     const decryptedHello = await client.decrypt(encryptedHello);
//     console.log('Decrypted data:', decryptedHello);

//     // Keep the process running
//     process.on('SIGINT', () => {
//       client.cleanup();
//       process.exit(0);
//     });
//   } catch (error) {
//     console.error('Error:', error);
//     process.exit(1);
//   }
// }

// main();
