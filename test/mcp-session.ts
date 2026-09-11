import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { REPO_ROOT } from './helpers.js';

/**
 * Shared MCP stdio test client. Lives outside `*.test.ts` on purpose: a
 * `*.test.ts` module's top-level `test()` calls re-register (and re-run) as a
 * side effect of being imported by another test file, so anything other test
 * files need to import must live in a plain module.
 */

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
}

export class McpSession {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private buffer = '';
  private pending = new Map<number, {
    resolve: (value: JsonRpcResponse) => void;
    reject: (error: Error) => void;
  }>();

  constructor(args: string[]) {
    this.child = spawn(
      process.execPath,
      ['--import', 'tsx', ...args],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          TZ: 'UTC',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      this.flushBuffer();
    });

    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', () => {
      // Keep stderr drained so the child cannot block.
    });

    this.child.on('exit', (code, signal) => {
      const reason = signal ? `signal ${signal}` : `code ${code}`;
      for (const { reject } of this.pending.values()) {
        reject(new Error(`MCP server exited before response (${reason})`));
      }
      this.pending.clear();
    });
  }

  private flushBuffer(): void {
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const raw = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (raw.length > 0) {
        const message = JSON.parse(raw) as JsonRpcResponse;
        if (typeof message.id === 'number' && this.pending.has(message.id)) {
          const pending = this.pending.get(message.id)!;
          this.pending.delete(message.id);
          pending.resolve(message);
        }
      }
      newline = this.buffer.indexOf('\n');
    }
  }

  async request(method: string, params?: unknown): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params,
    });

    const responsePromise = new Promise<JsonRpcResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });

    this.child.stdin.write(`${payload}\n`);
    return responsePromise;
  }

  notify(method: string, params?: unknown): void {
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      method,
      params,
    });

    this.child.stdin.write(`${payload}\n`);
  }

  async close(): Promise<void> {
    this.child.kill('SIGTERM');
    await once(this.child, 'exit');
  }
}
