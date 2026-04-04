import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';
import { once } from 'node:events';
import { makeTempProject, REPO_ROOT, runCli } from './helpers.js';

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
}

class McpSession {
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

test('mcp server lists all memspec tools over stdio', async () => {
  const session = new McpSession([join(REPO_ROOT, 'src/mcp.ts')]);

  try {
    const init = await session.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'memspec-test', version: '0.0.0' },
    });

    assert.equal(init.error, undefined);

    session.notify('notifications/initialized', {});

    const list = await session.request('tools/list');
    assert.equal(list.error, undefined);

    const tools = ((list.result as {
      tools: Array<{ name: string; description?: string }>;
    }).tools ?? []);
    const toolNames = tools.map((tool) => tool.name).sort();

    assert.deepEqual(toolNames, [
      'memspec_add',
      'memspec_correct',
      'memspec_decay',
      'memspec_get',
      'memspec_init',
      'memspec_search',
      'memspec_status',
      'memspec_validate',
    ]);

    const initTool = tools.find((tool) => tool.name === 'memspec_init');
    assert.ok(initTool?.description?.includes('existing memory files'));
    assert.ok(initTool?.description?.includes('AGENTS.md'));

    const searchTool = tools.find((tool) => tool.name === 'memspec_search');
    assert.ok(searchTool?.description?.includes('before answering'));
  } finally {
    await session.close();
  }
});

test('mcp search tool returns matching memories', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  await runCli([
    'add',
    'decision',
    'Credential isolation approach',
    '--cwd',
    target,
    '--body',
    'Same-machine proxy is obfuscation; real isolation requires network sandbox',
    '--source',
    'test',
    '--tags',
    'security,isolation',
  ]);

  const session = new McpSession([join(REPO_ROOT, 'src/mcp.ts'), '--cwd', target]);

  try {
    await session.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'memspec-test', version: '0.0.0' },
    });
    session.notify('notifications/initialized', {});

    const call = await session.request('tools/call', {
      name: 'memspec_search',
      arguments: {
        query: 'isolation',
        limit: 5,
      },
    });

    assert.equal(call.error, undefined);

    const result = call.result as {
      content?: Array<{ type: string; text: string }>;
      structuredContent?: { results?: Array<{ title: string; type: string }> };
    };

    assert.ok(result.structuredContent);
    assert.ok((result.structuredContent?.results?.length ?? 0) > 0);
    assert.equal(result.structuredContent?.results?.[0]?.title, 'Credential isolation approach');
    assert.equal(result.structuredContent?.results?.[0]?.type, 'decision');
  } finally {
    await session.close();
  }
});

test('mcp get tool returns full memory by id', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  await runCli([
    'add',
    'fact',
    'Test fact for MCP get',
    '--cwd',
    target,
    '--body',
    'Detailed body content here',
    '--source',
    'mcp-test',
  ]);

  // Extract the file to find the ID
  const store = await import('../src/lib/store.js').then((m) => new m.MemspecStore(target));
  const items = store.loadAll();
  assert.ok(items.length > 0);
  const itemId = items[0].id;

  const session = new McpSession([join(REPO_ROOT, 'src/mcp.ts'), '--cwd', target]);

  try {
    await session.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'memspec-test', version: '0.0.0' },
    });
    session.notify('notifications/initialized', {});

    const call = await session.request('tools/call', {
      name: 'memspec_get',
      arguments: { id: itemId },
    });

    assert.equal(call.error, undefined);

    const result = call.result as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.id, itemId);
    assert.equal(parsed.title, 'Test fact for MCP get');
    assert.ok(parsed.body.includes('Detailed body content here'));
    assert.equal(parsed.type, 'fact');
  } finally {
    await session.close();
  }
});

test('mcp status tool returns store summary', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  await runCli(['add', 'fact', 'Status test item', '--cwd', target, '--source', 'test']);

  const session = new McpSession([join(REPO_ROOT, 'src/mcp.ts'), '--cwd', target]);

  try {
    await session.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'memspec-test', version: '0.0.0' },
    });
    await session.request('notifications/initialized', {});

    const call = await session.request('tools/call', {
      name: 'memspec_status',
      arguments: {},
    });

    assert.equal(call.error, undefined);

    const result = call.result as { content: Array<{ text: string }> };
    assert.ok(result.content[0].text.includes('Memspec Store'));
    assert.ok(result.content[0].text.includes('fact'));
  } finally {
    await session.close();
  }
});
