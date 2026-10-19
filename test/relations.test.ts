import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { makeTempProject, readText, REPO_ROOT, runCli } from './helpers.js';
import { runExport } from '../src/commands/export.js';
import { runRelate } from '../src/commands/relate.js';
import { runRemember } from '../src/commands/remember.js';
import { EDGE_TYPES, expandGraph } from '../src/lib/graph-walk.js';
import { buildLineage } from '../src/lib/lineage.js';
import { MemspecStore } from '../src/lib/store.js';
import type { MemoryFrontmatter } from '../src/lib/types.js';

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

async function addFact(target: string, title: string, body = 'Body'): Promise<string> {
  await runCli(['remember', 'fact', title, '--cwd', target, '--body', body, '--source', 'test']);
  const factsDir = join(target, '.memspec', 'memory', 'facts');
  const entries = await readdir(factsDir);
  const newest = entries[entries.length - 1];
  return newest.replace(/\.md$/, '');
}

async function listFactIds(target: string): Promise<string[]> {
  const factsDir = join(target, '.memspec', 'memory', 'facts');
  const entries = await readdir(factsDir);
  return entries.map((f) => f.replace(/\.md$/, ''));
}

// --- 2.1 remember accepts typed relations ---

test('remember persists --refines / --supports / --depends-on through the CLI', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);

  const refinesTargetId = await addFact(target, 'Parent claim');
  const supportsTargetId = await addFact(target, 'Supported claim');
  const dependsTargetId = await addFact(target, 'Dependency claim');

  await runCli([
    'remember', 'fact', 'Child claim with edges',
    '--cwd', target,
    '--body', 'Body',
    '--source', 'test',
    '--refines', refinesTargetId,
    '--supports', supportsTargetId,
    '--depends-on', dependsTargetId,
  ]);

  const ids = await listFactIds(target);
  const childId = ids.find((id) => id !== refinesTargetId && id !== supportsTargetId && id !== dependsTargetId)!;
  assert.ok(childId, 'child fact should exist');

  const factPath = join(target, '.memspec', 'memory', 'facts', `${childId}.md`);
  const data = matter(await readText(factPath)).data as Record<string, unknown>;
  assert.deepEqual(data.refines, [refinesTargetId]);
  assert.deepEqual(data.supports, [supportsTargetId]);
  assert.deepEqual(data.depends_on, [dependsTargetId]);
});

test('remember deduplicates repeated edge ids in a single call', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);

  const parentId = await addFact(target, 'Parent claim');

  await runCli([
    'remember', 'fact', 'Child with duplicate refines',
    '--cwd', target,
    '--body', 'Body',
    '--source', 'test',
    '--refines', parentId, parentId,
  ]);

  const ids = await listFactIds(target);
  const childId = ids.find((id) => id !== parentId)!;
  const factPath = join(target, '.memspec', 'memory', 'facts', `${childId}.md`);
  const data = matter(await readText(factPath)).data as Record<string, unknown>;
  assert.deepEqual(data.refines, [parentId]);
});

test('mcp memspec_remember accepts typed relation arrays', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  const parentId = await addFact(target, 'Parent claim');

  const session = new McpSession([join(REPO_ROOT, 'src/mcp.ts'), '--cwd', target]);

  try {
    await session.init();

    const call = await session.request('tools/call', {
      name: 'memspec_remember',
      arguments: {
        type: 'fact',
        title: 'Edge-bearing claim via MCP',
        body: 'Body',
        source: 'mcp-test',
        refines: [parentId],
        depends_on: [parentId],
      },
    });

    assert.equal(call.error, undefined);
    const result = call.result as { structuredContent: { id: string } };
    const childId = result.structuredContent.id;
    assert.notEqual(childId, parentId);

    const factPath = join(target, '.memspec', 'memory', 'facts', `${childId}.md`);
    const data = matter(await readText(factPath)).data as Record<string, unknown>;
    assert.deepEqual(data.refines, [parentId]);
    assert.deepEqual(data.depends_on, [parentId]);
    assert.equal(data.supports, undefined, 'supports stays unset when not provided');
  } finally {
    await session.close();
  }
});

// --- 2.2 search result shape exposes the four edge types ---

test('search results expose conflicts_with, refines, supports, depends_on arrays', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);

  const parentId = await addFact(target, 'Parent topic alpha');

  await runCli([
    'remember', 'fact', 'Child refines parent alpha',
    '--cwd', target,
    '--body', 'Body',
    '--source', 'test',
    '--refines', parentId,
    '--supports', parentId,
    '--depends-on', parentId,
  ]);

  const out = await runCli(['search', 'alpha', '--cwd', target, '--json']);
  const parsed = JSON.parse(out.stdout).results as Array<Record<string, unknown>>;
  assert.ok(parsed.length >= 1);

  for (const hit of parsed) {
    assert.ok(Array.isArray(hit.conflicts_with), `${hit.id} conflicts_with should be array`);
    assert.ok(Array.isArray(hit.refines), `${hit.id} refines should be array`);
    assert.ok(Array.isArray(hit.supports), `${hit.id} supports should be array`);
    assert.ok(Array.isArray(hit.depends_on), `${hit.id} depends_on should be array`);
  }

  const child = parsed.find((h) => (h.title as string).startsWith('Child refines'));
  assert.ok(child, 'child result should be present');
  assert.deepEqual(child!.refines, [parentId]);
  assert.deepEqual(child!.supports, [parentId]);
  assert.deepEqual(child!.depends_on, [parentId]);

  const parent = parsed.find((h) => (h.title as string) === 'Parent topic alpha');
  assert.ok(parent, 'parent result should be present');
  assert.deepEqual(parent!.refines, []);
  assert.deepEqual(parent!.supports, []);
  assert.deepEqual(parent!.depends_on, []);
});

// --- 2.3 lineage exposes the three new chains ---

test('mcp_get returns refines_chain / supports_chain / depends_on_chain', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);

  const a = await addFact(target, 'Ancestor A');
  await runCli(['remember', 'fact', 'Middle B', '--cwd', target, '--body', 'Body', '--source', 'test', '--refines', a]);
  const ids1 = await listFactIds(target);
  const b = ids1.find((id) => id !== a)!;
  await runCli(['remember', 'fact', 'Leaf C', '--cwd', target, '--body', 'Body', '--source', 'test', '--refines', b]);
  const ids2 = await listFactIds(target);
  const c = ids2.find((id) => id !== a && id !== b)!;

  const session = new McpSession([join(REPO_ROOT, 'src/mcp.ts'), '--cwd', target]);
  try {
    await session.init();

    const call = await session.request('tools/call', {
      name: 'memspec_get',
      arguments: { id: c },
    });
    assert.equal(call.error, undefined);
    const result = call.result as { content: Array<{ text: string }> };
    const payload = JSON.parse(result.content[0].text);

    assert.ok(payload.lineage, 'lineage block present');
    assert.ok(Array.isArray(payload.lineage.refines_chain));
    assert.ok(Array.isArray(payload.lineage.supports_chain));
    assert.ok(Array.isArray(payload.lineage.depends_on_chain));

    // C refines B; B refines A → outward walk from C should reach both within depth 3.
    const chainIds = payload.lineage.refines_chain.map((e: { id: string }) => e.id);
    assert.deepEqual(chainIds, [b, a]);
    assert.equal(payload.lineage.supports_chain.length, 0);
    assert.equal(payload.lineage.depends_on_chain.length, 0);

    // Existing v0.3 lineage fields stay populated.
    assert.ok(Array.isArray(payload.lineage.ancestors));
    assert.ok(Array.isArray(payload.lineage.descendants));
  } finally {
    await session.close();
  }
});

test('lineage refines_chain terminates at depth limit', async () => {
  const { buildLineage, RELATION_CHAIN_DEPTH } = await import('../src/lib/lineage.js');
  const { MemspecStore } = await import('../src/lib/store.js');

  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);

  // Build a chain a0 ← a1 ← a2 ← a3 ← a4 ← a5 (each refines the previous).
  const chain: string[] = [];
  for (let i = 0; i < 6; i++) {
    if (chain.length === 0) {
      chain.push(await addFact(target, `Node ${i}`));
    } else {
      const prev = chain[chain.length - 1];
      await runCli(['remember', 'fact', `Node ${i}`, '--cwd', target, '--body', 'Body', '--source', 'test', '--refines', prev]);
      const all = await listFactIds(target);
      const next = all.find((id) => !chain.includes(id))!;
      chain.push(next);
    }
  }

  const store = new MemspecStore(target);
  const allItems = store.loadAll();
  const seed = allItems.find((i) => i.id === chain[chain.length - 1])!;
  const lineage = buildLineage(seed, allItems);

  assert.equal(lineage.refines_chain.length, RELATION_CHAIN_DEPTH,
    `chain length should cap at RELATION_CHAIN_DEPTH (${RELATION_CHAIN_DEPTH})`);
});

test('lineage refines_chain handles cycles without infinite recursion', async () => {
  const { buildLineage } = await import('../src/lib/lineage.js');
  const { MemspecStore } = await import('../src/lib/store.js');

  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);

  const a = await addFact(target, 'Cycle node A');
  const b = await addFact(target, 'Cycle node B');

  // Hand-link A→B via relate, then B→A to form a cycle. Relate enforces no
  // self-edges but doesn't reject cycles between distinct ids — that's the
  // lineage walker's responsibility.
  await runCli(['relate', '--cwd', target, '--from', a, '--to', b, '--type', 'refines']);
  await runCli(['relate', '--cwd', target, '--from', b, '--to', a, '--type', 'refines']);

  const store = new MemspecStore(target);
  const allItems = store.loadAll();
  const seed = allItems.find((i) => i.id === a)!;
  const lineage = buildLineage(seed, allItems);

  // BFS from A reaches B (hop 1); A is in the visited set so the cycle stops.
  const ids = lineage.refines_chain.map((e) => e.id);
  assert.deepEqual(ids, [b]);
});

// --- 2.4 relate command ---

test('relate adds an edge and dedupes on replay', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);

  const fromId = await addFact(target, 'Edge origin');
  const toId = await addFact(target, 'Edge target');

  const first = await runCli(['relate', '--cwd', target, '--from', fromId, '--to', toId, '--type', 'supports']);
  assert.match(first.stdout, /Linked .* -\[supports\]->/);

  const second = await runCli(['relate', '--cwd', target, '--from', fromId, '--to', toId, '--type', 'supports']);
  assert.match(second.stdout, /already present/);

  const factPath = join(target, '.memspec', 'memory', 'facts', `${fromId}.md`);
  const data = matter(await readText(factPath)).data as Record<string, unknown>;
  assert.deepEqual(data.supports, [toId]);
});

test('relate rejects missing from / to ids', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  const realId = await addFact(target, 'Real claim');

  await assert.rejects(
    () => runCli(['relate', '--cwd', target, '--from', 'ms_00000000000000000000000000', '--to', realId, '--type', 'refines']),
    (err: Error & { stderr?: string }) => {
      assert.match(`${err.message}\n${err.stderr ?? ''}`, /Memory not found/);
      return true;
    },
  );

  await assert.rejects(
    () => runCli(['relate', '--cwd', target, '--from', realId, '--to', 'ms_00000000000000000000000000', '--type', 'refines']),
    (err: Error & { stderr?: string }) => {
      assert.match(`${err.message}\n${err.stderr ?? ''}`, /Memory not found/);
      return true;
    },
  );
});

test('relate rejects unknown edge types', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  const a = await addFact(target, 'A');
  const b = await addFact(target, 'B');

  await assert.rejects(
    () => runCli(['relate', '--cwd', target, '--from', a, '--to', b, '--type', 'enemies_with']),
    (err: Error & { stderr?: string }) => {
      assert.match(`${err.message}\n${err.stderr ?? ''}`, /--type must be one of/);
      return true;
    },
  );
});

test('mcp memspec_relate writes an edge and reports added flag', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  const fromId = await addFact(target, 'MCP origin');
  const toId = await addFact(target, 'MCP target');

  const session = new McpSession([join(REPO_ROOT, 'src/mcp.ts'), '--cwd', target]);
  try {
    await session.init();

    const first = await session.request('tools/call', {
      name: 'memspec_relate',
      arguments: { from: fromId, to: toId, type: 'depends_on' },
    });
    assert.equal(first.error, undefined);
    const firstRes = first.result as { structuredContent: { added: boolean; total_edges_of_type: number } };
    assert.equal(firstRes.structuredContent.added, true);
    assert.equal(firstRes.structuredContent.total_edges_of_type, 1);

    const second = await session.request('tools/call', {
      name: 'memspec_relate',
      arguments: { from: fromId, to: toId, type: 'depends_on' },
    });
    const secondRes = second.result as { structuredContent: { added: boolean } };
    assert.equal(secondRes.structuredContent.added, false);
  } finally {
    await session.close();
  }
});

// --- v0.13 distinct_from ---

async function initDistinctProject(): Promise<{ target: string; ids: string[] }> {
  const target = await makeTempProject();
  new MemspecStore(target).init();
  const ids = ['Invoice numbering', 'Meter import cadence', 'Tariff table layout'].map(
    (title) => runRemember('fact', title, { cwd: target, source: 'test', body: `${title}.` }).id,
  );
  return { target, ids };
}

test('relate distinct_from writes the edge and dedupes on replay', async () => {
  const { target, ids: [a, b] } = await initDistinctProject();
  const first = runRelate({ cwd: target, from: a, to: b, type: 'distinct_from' });
  assert.equal(first.added, true);
  assert.match(first.message, /-\[distinct_from\]->/);
  assert.equal(runRelate({ cwd: target, from: a, to: b, type: 'distinct_from' }).added, false);
  const raw = await readText(join(target, '.memspec', 'memory', 'facts', `${a}.md`));
  assert.deepEqual(matter(raw).data.distinct_from, [b]);
});

test('relate refuses distinct_from to a target already on any other edge list, and every other edge to a distinct_from target', async () => {
  const { target, ids: [a, b, c] } = await initDistinctProject();
  for (const type of ['refines', 'supports', 'depends_on', 'derived_from', 'conflicts_with'] as const) {
    const fresh = await initDistinctProject();
    const [x, y] = fresh.ids;
    runRelate({ cwd: fresh.target, from: x, to: y, type });
    assert.throws(
      () => runRelate({ cwd: fresh.target, from: x, to: y, type: 'distinct_from' }),
      new RegExp(`relate refuses distinct_from .*already declares ${type}`),
      `distinct_from after ${type}`,
    );
  }
  runRelate({ cwd: target, from: a, to: b, type: 'distinct_from' });
  for (const type of ['refines', 'supports', 'depends_on', 'derived_from', 'conflicts_with'] as const) {
    assert.throws(
      () => runRelate({ cwd: target, from: a, to: b, type }),
      /already declares distinct_from that target/,
      `${type} after distinct_from`,
    );
  }
  // A different target is unaffected.
  assert.equal(runRelate({ cwd: target, from: a, to: c, type: 'refines' }).added, true);
});

test('relate --type distinct_from works through the CLI and appears in --help', async () => {
  const { target, ids: [a, b] } = await initDistinctProject();
  const out = await runCli(['relate', '--cwd', target, '--from', a, '--to', b, '--type', 'distinct_from']);
  assert.match(out.stdout, /-\[distinct_from\]->/);
  const help = await runCli(['relate', '--help']);
  assert.match(help.stdout, /distinct_from/);
  const rememberHelp = await runCli(['remember', '--help']);
  assert.match(rememberHelp.stdout, /--distinct-from/);
});

test('remember --distinct-from validates the target, writes the edge, excludes it from suggestions, and refuses a contradicting edge', async () => {
  const { target, ids: [a] } = await initDistinctProject();
  assert.throws(
    () => runRemember('fact', 'Invoice numbering per year', { cwd: target, source: 'test', distinctFrom: ['ms_00000000000000000000000000'] }),
    /--distinct-from target not found/,
  );
  assert.throws(
    () => runRemember('fact', 'Invoice numbering per year', { cwd: target, source: 'test', distinctFrom: [a], refines: [a] }),
    /--distinct-from .* contradicts the refines edge/,
  );
  const r = runRemember('fact', 'Invoice numbering per year', { cwd: target, source: 'test', distinctFrom: [a, a] });
  assert.match(r.message, /Distinct from: /);
  assert.equal((r.suggestedConflicts ?? []).some((s) => s.id === a), false);
  const stored = new MemspecStore(target).findById(r.id)!;
  assert.deepEqual(stored.distinct_from, [a]);
});

test('distinct_from is not a retrieval edge: graph-walk and lineage ignore it; export emits it', async () => {
  assert.equal((EDGE_TYPES as readonly string[]).includes('distinct_from'), false);
  const A = 'ms_01AAAAAAAAAAAAAAAAAAAAAAAA';
  const B = 'ms_01BBBBBBBBBBBBBBBBBBBBBBBB';
  const records = new Map<string, MemoryFrontmatter>([
    [A, { id: A, kind: 'claim', type: 'fact', state: 'active', created: '2026-01-01T00:00:00Z', source: 't', tags: [], check_by: 'never', distinct_from: [B] }],
    [B, { id: B, kind: 'claim', type: 'fact', state: 'active', created: '2026-01-01T00:00:00Z', source: 't', tags: [], check_by: 'never' }],
  ]);
  assert.deepEqual(expandGraph([A], records, { maxDepth: 3 }), []);

  const { target, ids: [a, b] } = await initDistinctProject();
  runRelate({ cwd: target, from: a, to: b, type: 'distinct_from' });
  const store = new MemspecStore(target);
  const lineage = buildLineage(store.findById(a)!, store.loadAll());
  assert.deepEqual(
    [lineage.refines_chain, lineage.supports_chain, lineage.depends_on_chain, lineage.derived_from_chain],
    [[], [], [], []],
  );
  const lines = runExport({ cwd: target, format: 'jsonl' }).trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.some((e) => e.kind === 'edge' && e.type === 'distinct_from' && e.from === a && e.to === b));
  const dot = runExport({ cwd: target, format: 'dot' });
  assert.match(dot, /label="distinct_from"[^\]]*color="gray"[^\]]*style="dotted"/);
});

test('mcp memspec_relate / memspec_remember accept distinct_from and memspec_get echoes it', async () => {
  const { target, ids: [a, b] } = await initDistinctProject();
  const session = new McpSession([join(REPO_ROOT, 'src/mcp.ts'), '--cwd', target]);
  try {
    await session.init();
    const list = await session.request('tools/list');
    const tools = (list.result as { tools: Array<{ name: string; description?: string; inputSchema?: { properties?: Record<string, { description?: string; enum?: string[] }> } }> }).tools;
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of ['memspec_relate', 'memspec_unrelate']) {
      const tool = byName.get(name)!;
      assert.ok(tool.description?.includes('distinct_from'), `${name} description`);
      assert.ok(tool.inputSchema?.properties?.type?.enum?.includes('distinct_from'), `${name} type enum`);
    }
    assert.ok(byName.get('memspec_remember')!.inputSchema?.properties?.distinct_from, 'remember distinct_from param');

    const rel = await session.request('tools/call', { name: 'memspec_relate', arguments: { from: a, to: b, type: 'distinct_from' } });
    assert.equal((rel.result as { structuredContent: { added: boolean } }).structuredContent.added, true);

    const rem = await session.request('tools/call', {
      name: 'memspec_remember',
      arguments: { type: 'fact', title: 'Meter import window', body: 'B', source: 'mcp-test', distinct_from: [b] },
    });
    const newId = (rem.result as { structuredContent: { id: string } }).structuredContent.id;
    const got = await session.request('tools/call', { name: 'memspec_get', arguments: { id: newId } });
    assert.deepEqual((got.result as { structuredContent: { distinct_from?: string[] } }).structuredContent.distinct_from, [b]);
  } finally {
    await session.close();
  }
});
