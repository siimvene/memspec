import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { runRemember } from '../src/commands/remember.js';
import { makeTempProject, readText, REPO_ROOT, runCli } from './helpers.js';

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
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
        env: { ...process.env, TZ: 'UTC' },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      this.flushBuffer();
    });

    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', () => { /* drain */ });

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
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const responsePromise = new Promise<JsonRpcResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.child.stdin.write(`${payload}\n`);
    return responsePromise;
  }

  notify(method: string, params?: unknown): void {
    const payload = JSON.stringify({ jsonrpc: '2.0', method, params });
    this.child.stdin.write(`${payload}\n`);
  }

  async close(): Promise<void> {
    this.child.kill('SIGTERM');
    await once(this.child, 'exit');
  }

  async init(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'memspec-test', version: '0.0.0' },
    });
    this.notify('notifications/initialized', {});
  }
}

async function readFact(target: string, id: string): Promise<Record<string, unknown>> {
  const factPath = join(target, '.memspec', 'memory', 'facts', `${id}.md`);
  return matter(await readText(factPath)).data as Record<string, unknown>;
}

// --- 5.1 high band still refuses ---------------------------------------------

test('remember refuses near-duplicate when an active same-type record shares the title', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);

  runRemember('fact', 'Telemetry pipeline batches events hourly', {
    cwd: target,
    body: 'first',
    source: 'agent-a',
  });

  assert.throws(
    () => runRemember('fact', 'Telemetry pipeline batches events hourly', {
      cwd: target,
      body: 'second',
      source: 'agent-b',
    }),
    (err: Error) => {
      assert.match(err.message, /refuses near-duplicate/);
      assert.match(err.message, /memspec supersede/);
      return true;
    },
  );

  const factsDir = join(target, '.memspec', 'memory', 'facts');
  const entries = await readdir(factsDir);
  assert.equal(entries.length, 1, 'high-band refusal must not write a twin');
});

test('remember refusal is case-insensitive and whitespace-tolerant', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);

  runRemember('fact', 'Service runs on port 4001', { cwd: target, body: 'b', source: 'agent-a' });

  assert.throws(
    () => runRemember('fact', '  SERVICE runs  on   port 4001 ', {
      cwd: target,
      body: 'b',
      source: 'agent-b',
    }),
    /refuses near-duplicate/,
  );
});

// --- 5.2 mid band attaches ---------------------------------------------------

test('remember commits a mid-band record and auto-attaches conflicts_with to the closest neighbour', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);

  const parent = runRemember('fact', 'Cache invalidation runs nightly globally', {
    cwd: target,
    body: 'parent',
    source: 'agent-a',
    tags: 'cache',
  });

  const child = runRemember('fact', 'Cache invalidation runs hourly nightly globally', {
    cwd: target,
    body: 'child',
    source: 'agent-b',
    tags: 'cache',
  });

  assert.ok(child.autoAttached, 'mid-band write should produce an autoAttached descriptor');
  assert.equal(child.autoAttached!.type, 'conflicts_with');
  assert.equal(child.autoAttached!.target_id, parent.id);
  assert.equal(child.autoAttached!.reason, 'mid-band similarity inference');

  const data = await readFact(target, child.id);
  assert.deepEqual(data.conflicts_with, [parent.id]);

  const parentData = await readFact(target, parent.id);
  assert.equal(parentData.conflicts_with, undefined,
    'mid-band auto-attach writes the edge into the new record only');
});

// --- 5.3 mid band picks the highest-scoring neighbour ------------------------

test('remember picks the single highest-scoring mid-band candidate when several match', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);

  // Two distinct neighbours, both rule-eligible. The first overlaps on fewer
  // tokens; the second overlaps on more. Phase 5 must attach to the latter
  // and only the latter — single edge per write.
  const distant = runRemember('fact', 'Telemetry pipeline buffers events offline', {
    cwd: target, body: 'distant', source: 'agent-a', tags: 'telemetry',
  });
  const closer = runRemember('fact', 'Telemetry pipeline buffers replicated events nightly', {
    cwd: target, body: 'closer', source: 'agent-a', tags: 'telemetry',
  });

  const child = runRemember('fact', 'Telemetry pipeline buffers replicated events offline nightly', {
    cwd: target, body: 'child', source: 'agent-b', tags: 'telemetry',
  });

  assert.ok(child.autoAttached);
  assert.equal(child.autoAttached!.target_id, closer.id,
    'expected the higher-token-overlap candidate to win');
  assert.notEqual(child.autoAttached!.target_id, distant.id);

  const data = await readFact(target, child.id);
  assert.deepEqual(data.conflicts_with, [closer.id], 'single edge max per write');
});

// --- 5.4 low band is clean ---------------------------------------------------

test('remember writes cleanly with no auto-attach when no shared tags / no token overlap exist', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);

  runRemember('fact', 'Database snapshots taken weekly', {
    cwd: target, body: 'a', source: 'agent-a', tags: 'db',
  });

  const result = runRemember('fact', 'Frontend ships via Cloudflare Pages', {
    cwd: target, body: 'b', source: 'agent-b', tags: 'frontend',
  });

  assert.equal(result.autoAttached, undefined, 'low-band write must not auto-attach');

  const data = await readFact(target, result.id);
  assert.equal(data.conflicts_with, undefined, 'low-band write keeps conflicts_with absent');
});

// --- 5.5 operator-tier protection from agent writes --------------------------

test('agent writes do not auto-attach to operator-tier candidates', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);

  // Operator-tier seed — `human:siim` source maps to source_kind: operator.
  runRemember('fact', 'Production database is Postgres 15 hosted on Supabase', {
    cwd: target, body: 'operator note', source: 'human:siim', tags: 'db',
  });

  // Agent-tier write that would otherwise fall into mid-band against the
  // operator record (same type, shared tag, >=2 title-token overlap).
  const result = runRemember('fact', 'Production database connection pool sized hosted', {
    cwd: target, body: 'agent note', source: 'claude-code', tags: 'db',
  });

  assert.equal(result.autoAttached, undefined,
    'agent writes must not silently annotate operator memory with auto-attached edges');

  // The record still commits cleanly.
  const factsDir = join(target, '.memspec', 'memory', 'facts');
  const agentEntries = await readdir(factsDir);
  assert.equal(agentEntries.length, 1, 'agent record committed');
  const data = matter(await readText(join(factsDir, agentEntries[0]))).data as Record<string, unknown>;
  assert.equal(data.conflicts_with, undefined);
});

test('operator writes may still auto-attach to operator candidates', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);

  const seed = runRemember('fact', 'Production database hosted Supabase Postgres', {
    cwd: target, body: 'seed', source: 'human:siim', tags: 'db',
  });

  const second = runRemember('fact', 'Production database hosted region replication Postgres', {
    cwd: target, body: 'second', source: 'human:siim', tags: 'db',
  });

  assert.ok(second.autoAttached, 'operator-to-operator mid-band should still auto-attach');
  assert.equal(second.autoAttached!.target_id, seed.id);
});

// --- 5.6 MCP tool response shape --------------------------------------------

test('memspec_remember MCP response includes auto_attached when mid-band fires', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);

  const seed = runRemember('fact', 'Worker queue drains every five minutes', {
    cwd: target, body: 'seed', source: 'agent-a', tags: 'worker',
  });

  const session = new McpSession([join(REPO_ROOT, 'src/mcp.ts'), '--cwd', target]);
  try {
    await session.init();

    // Mid-band call — should write and surface auto_attached.
    const midCall = await session.request('tools/call', {
      name: 'memspec_remember',
      arguments: {
        type: 'fact',
        title: 'Worker queue drains every fifteen minutes lately',
        body: 'mid-band',
        source: 'agent-b',
        tags: ['worker'],
      },
    });
    assert.equal(midCall.error, undefined);
    const midResult = midCall.result as { structuredContent: Record<string, unknown> };
    const attached = midResult.structuredContent.auto_attached as Array<Record<string, unknown>> | undefined;
    assert.ok(Array.isArray(attached), 'auto_attached should be present as array');
    assert.equal(attached!.length, 1);
    assert.equal(attached![0].type, 'conflicts_with');
    assert.equal(attached![0].target_id, seed.id);
    assert.equal(attached![0].reason, 'mid-band similarity inference');

    // Low-band call — auto_attached must be absent (not present as empty array).
    const lowCall = await session.request('tools/call', {
      name: 'memspec_remember',
      arguments: {
        type: 'fact',
        title: 'Operator dashboard ships dark mode',
        body: 'low-band',
        source: 'agent-c',
        tags: ['ui'],
      },
    });
    assert.equal(lowCall.error, undefined);
    const lowResult = lowCall.result as { structuredContent: Record<string, unknown> };
    assert.equal(lowResult.structuredContent.auto_attached, undefined,
      'low-band write must omit auto_attached entirely');
  } finally {
    await session.close();
  }
});
