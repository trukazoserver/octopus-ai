import { spawn, ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { MCPServerConfig } from '../types.js';

export class MCPClient {
  private config: MCPServerConfig;
  private process: ChildProcess | null = null;
  private pendingRequests = new Map<string, { resolve: (val: any) => void; reject: (err: any) => void }>();
  private buffer = '';

  constructor(config: MCPServerConfig) {
    this.config = config;
  }

  public async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.process = spawn(this.config.command, this.config.args || [], {
          env: { ...process.env, ...this.config.env },
          stdio: ['pipe', 'pipe', 'inherit'],
        });

        this.process.on('error', (err) => {
          if (this.pendingRequests.size === 0) {
            reject(err);
          }
        });

        this.process.on('exit', () => {
          for (const { reject: rejectRequest } of this.pendingRequests.values()) {
            rejectRequest(new Error('Process exited'));
          }
          this.pendingRequests.clear();
          this.process = null;
        });

        if (this.process.stdout) {
          this.process.stdout.on('data', (chunk: Buffer) => {
            this.buffer += chunk.toString('utf-8');
            this.processBuffer();
          });
        }

        this.request('ping', {}).then(() => {
          resolve();
        }).catch((err) => {
          reject(err);
        });

      } catch (error) {
        reject(error);
      }
    });
  }

  public async disconnect(): Promise<void> {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    for (const { reject: rejectRequest } of this.pendingRequests.values()) {
      rejectRequest(new Error('Client disconnected'));
    }
    this.pendingRequests.clear();
    this.buffer = '';
  }

  public async request<T>(method: string, params: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.process || !this.process.stdin) {
        return reject(new Error('Process is not running'));
      }

      const id = randomUUID();
      this.pendingRequests.set(id, { resolve, reject });

      const message = {
        jsonrpc: '2.0',
        id,
        method,
        params,
      };

      this.process.stdin.write(JSON.stringify(message) + '\n', (error) => {
        if (error) {
          this.pendingRequests.delete(id);
          reject(error);
        }
      });
    });
  }

  public notify(method: string, params: unknown): void {
    if (!this.process || !this.process.stdin) {
      throw new Error('Process is not running');
    }

    const message = {
      jsonrpc: '2.0',
      method,
      params,
    };

    this.process.stdin.write(JSON.stringify(message) + '\n');
  }

  private processBuffer() {
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (!line) {
        continue;
      }

      try {
        const message = JSON.parse(line);
        this.handleMessage(message);
      } catch (error) {
        console.error('Failed to parse JSON-RPC message:', error);
      }
    }
  }

  private handleMessage(message: any) {
    if (message.jsonrpc !== '2.0') return;

    if ('id' in message && this.pendingRequests.has(message.id)) {
      const request = this.pendingRequests.get(message.id)!;
      this.pendingRequests.delete(message.id);

      if ('error' in message && message.error) {
        request.reject(new Error(message.error.message || 'JSON-RPC Error'));
      } else {
        request.resolve(message.result);
      }
    }
  }
}
