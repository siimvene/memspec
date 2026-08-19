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

// --- 5.2 mid band SUGGESTS, never writes -------------------------------------

test('remember suggests a mid-band conflict but writes no conflicts_with edge', async () => {
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

  assert.ok(child.suggestedConflicts, 'mid-band write should produce suggestions');
  assert.ok(child.suggestedConflicts!.some((s) => s.id === parent.id),
    'the closest neighbour is surfaced as a suggestion');
  const suggestion = child.suggestedConflicts!.find((s) => s.id === parent.id)!;
  assert.equal(suggestion.title, 'Cache invalidation runs nightly globally');
  assert.match(suggestion.rationale, /shared tag\(s\): cache/);

  // The whole point: nothing is written on EITHER record.
  const data = await readFact(target, child.id);
  assert.equal(data.conflicts_with, undefined, 'suggestion-only: no conflicts_with on the new record');
  const parentData = await readFact(target, parent.id);
  assert.equal(parentData.conflicts_with, undefined, 'suggestion-only: no conflicts_with on the neighbour');
});

// --- 5.3 suggestions are ranked, highest-overlap first -----------------------

test('remember ranks mid-band suggestions by lexical closeness', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);

  const distant = runRemember('fact', 'Telemetry pipeline buffers events offline', {
    cwd: target, body: 'distant', source: 'agent-a', tags: 'telemetry',
  });
  const closer = runRemember('fact', 'Telemetry pipeline buffers replicated events nightly', {
    cwd: target, body: 'closer', source: 'agent-a', tags: 'telemetry',
  });

  const child = runRemember('fact', 'Telemetry pipeline buffers replicated events offline nightly', {
    cwd: target, body: 'child', source: 'agent-b', tags: 'telemetry',
  });

  assert.ok(child.suggestedConflicts && child.suggestedConflicts.length >= 1);
  assert.equal(child.suggestedConflicts![0].id, closer.id,
    'the higher-token-overlap candidate ranks first');
  assert.ok(child.suggestedConflicts!.some((s) => s.id === distant.id),
    'the weaker candidate is still surfaced, just lower');

  const data = await readFact(target, child.id);
  assert.equal(data.conflicts_with, undefined, 'suggestions never write an edge');
});

// --- 5.4 low band is clean ---------------------------------------------------

test('remember writes cleanly with no suggestions when no shared tags / no token overlap exist', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);

  runRemember('fact', 'Database snapshots taken weekly', {
    cwd: target, body: 'a', source: 'agent-a', tags: 'db',
  });

  const result = runRemember('fact', 'Frontend ships via Cloudflare Pages', {
    cwd: target, body: 'b', source: 'agent-b', tags: 'frontend',
  });

  assert.equal(result.suggestedConflicts, undefined, 'low-band write must not suggest');

  const data = await readFact(target, result.id);
  assert.equal(data.conflicts_with, undefined, 'low-band write keeps conflicts_with absent');
});

// --- 5.5 operator-tier protection from agent writes --------------------------

test('agent writes are not offered operator-tier candidates as suggestions', async () => {
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

  assert.equal(result.suggestedConflicts, undefined,
    'agent writes must not be nudged to wire conflicts onto operator memory');

  const factsDir = join(target, '.memspec', 'memory', 'facts');
  const agentEntries = await readdir(factsDir);
  assert.equal(agentEntries.length, 1, 'agent record committed');
  const data = matter(await readText(join(factsDir, agentEntries[0]))).data as Record<string, unknown>;
  assert.equal(data.conflicts_with, undefined);
});

test('operator writes may still be offered operator candidates as suggestions', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);

  const seed = runRemember('fact', 'Production database hosted Supabase Postgres', {
    cwd: target, body: 'seed', source: 'human:siim', tags: 'db',
  });

  const second = runRemember('fact', 'Production database hosted region replication Postgres', {
    cwd: target, body: 'second', source: 'human:siim', tags: 'db',
  });

  assert.ok(second.suggestedConflicts, 'operator-to-operator mid-band should still suggest');
  assert.ok(second.suggestedConflicts!.some((s) => s.id === seed.id));
});

// --- 5.7 caller-declared positive edges suppress the suggestion --------------
// A target the caller has already classified with a positive edge must not be
// suggested as a conflict — that is the contradiction the old auto-attach made.

for (const edge of ['refines', 'supports', 'dependsOn'] as const) {
  test(`remember does not suggest a conflict to a target declared via ${edge}`, async () => {
    const target = await makeTempProject();
    await runCli(['init', '--cwd', target]);

    const parent = runRemember('fact', 'Cache invalidation runs nightly globally', {
      cwd: target, body: 'parent', source: 'agent-a', tags: 'cache',
    });

    const child = runRemember('fact', 'Cache invalidation runs hourly nightly globally', {
      cwd: target, body: 'child', source: 'agent-b', tags: 'cache', [edge]: [parent.id],
    });

    const suggestsParent = (child.suggestedConflicts ?? []).some((s) => s.id === parent.id);
    assert.equal(suggestsParent, false,
      'a caller-declared positive edge suppresses the conflict suggestion to that same target');

    const data = await readFact(target, child.id);
    assert.equal(data.conflicts_with, undefined);
  });
}

test('remember still suggests an undeclared neighbour when another is caller-declared', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);

  const declared = runRemember('fact', 'Cache invalidation runs nightly globally', {
    cwd: target, body: 'declared', source: 'agent-a', tags: 'cache',
  });
  const undeclared = runRemember('fact', 'Cache invalidation runs hourly regional', {
    cwd: target, body: 'undeclared', source: 'agent-a', tags: 'cache',
  });

  const child = runRemember('fact', 'Cache invalidation runs nightly hourly', {
    cwd: target, body: 'child', source: 'agent-b', tags: 'cache', refines: [declared.id],
  });

  const suggested = child.suggestedConflicts ?? [];
  assert.ok(suggested.some((s) => s.id === undeclared.id),
    'inference should still surface the undeclared neighbour');
  assert.ok(!suggested.some((s) => s.id === declared.id),
    'the declared target stays out of the suggestions');

  const data = await readFact(target, child.id);
  assert.equal(data.conflicts_with, undefined);
  assert.deepEqual(data.refines, [declared.id]);
});

// --- 5.8 caller-asserted conflicts_with (--conflicts-with) -------------------

test('remember --conflicts-with writes the edge and marks it asserted', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);

  const other = runRemember('fact', 'Sessions expire after 24 hours', {
    cwd: target, body: 'a', source: 'agent-a', tags: 'auth',
  });

  const child = runRemember('fact', 'Sessions expire after 1 hour', {
    cwd: target, body: 'b', source: 'agent-b', tags: 'auth', conflictsWith: [other.id],
  });

  const data = await readFact(target, child.id);
  assert.deepEqual(data.conflicts_with, [other.id], 'asserted edge is written');
  const ext = data.ext as Record<string, unknown> | undefined;
  assert.ok(ext && typeof ext.edge_sources === 'object', 'ext.edge_sources present');
  assert.equal((ext!.edge_sources as Record<string, string>)[other.id], 'asserted',
    'the caller-asserted edge carries the asserted provenance mark');
});

test('remember --conflicts-with excludes the asserted target from suggestions (M2)', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);

  // A mid-band neighbour that WOULD be suggested, but the caller is already
  // asserting the conflict — so it must not come back as a suggestion too.
  const parent = runRemember('fact', 'Cache invalidation runs nightly globally', {
    cwd: target, body: 'parent', source: 'agent-a', tags: 'cache',
  });
  const child = runRemember('fact', 'Cache invalidation runs hourly nightly globally', {
    cwd: target, body: 'child', source: 'agent-b', tags: 'cache', conflictsWith: [parent.id],
  });

  const suggestsParent = (child.suggestedConflicts ?? []).some((s) => s.id === parent.id);
  assert.equal(suggestsParent, false, 'an asserted conflict target is not re-suggested');

  const data = await readFact(target, child.id);
  assert.deepEqual(data.conflicts_with, [parent.id], 'the asserted edge is still written');
});

test('remember --conflicts-with rejects a non-existent target', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);

  assert.throws(
    () => runRemember('fact', 'Some claim', {
      cwd: target, body: 'b', source: 'agent-b', conflictsWith: ['ms_00000000000000000000000000'],
    }),
    /--conflicts-with target not found/,
  );
});

test('remember --conflicts-with refuses a target also declared via a positive edge', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);

  const parent = runRemember('fact', 'Base claim about caching', {
    cwd: target, body: 'a', source: 'agent-a', tags: 'cache',
  });

  assert.throws(
    () => runRemember('fact', 'Derived claim about caching', {
      cwd: target, body: 'b', source: 'agent-b', tags: 'cache',
      refines: [parent.id], conflictsWith: [parent.id],
    }),
    /contradicts a positive edge/,
  );
});

// --- 5.6 MCP tool response shape --------------------------------------------

test('memspec_remember MCP response surfaces suggested_conflicts, never writes an edge', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);

  const seed = runRemember('fact', 'Worker queue drains every five minutes', {
    cwd: target, body: 'seed', source: 'agent-a', tags: 'worker',
  });

  const session = new McpSession([join(REPO_ROOT, 'src/mcp.ts'), '--cwd', target]);
  try {
    await session.init();

    // Mid-band call — should write the record but only SUGGEST the conflict.
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
    const suggested = midResult.structuredContent.suggested_conflicts as Array<Record<string, unknown>> | undefined;
    assert.ok(Array.isArray(suggested), 'suggested_conflicts should be present as array');
    assert.ok(suggested!.some((s) => s.id === seed.id));
    assert.equal(midResult.structuredContent.auto_attached, undefined, 'auto_attached is gone in v0.10');

    const newId = midResult.structuredContent.id as string;
    const data = await readFact(target, newId);
    assert.equal(data.conflicts_with, undefined, 'MCP mid-band write must not persist an edge');

    // Low-band call — suggested_conflicts must be absent.
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
    assert.equal(lowResult.structuredContent.suggested_conflicts, undefined,
      'low-band write must omit suggested_conflicts entirely');
  } finally {
    await session.close();
  }
});
