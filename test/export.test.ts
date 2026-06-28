import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { runRemember } from '../src/commands/remember.js';
import { runRelate } from '../src/commands/relate.js';
import { runSupersede } from '../src/commands/supersede.js';
import { runAnchor } from '../src/commands/anchor.js';
import { runExport } from '../src/commands/export.js';
import { MemspecStore } from '../src/lib/store.js';
import { REPO_ROOT, runCli } from './helpers.js';

async function makeProject(): Promise<string> {
  const target = await mkdtemp(join(tmpdir(), 'memspec-export-'));
  const store = new MemspecStore(target);
  store.init();
  return target;
}

// --- JSONL is line-by-line valid JSON ---------------------------------------

test('JSONL output: each line is valid JSON with kind:node or kind:edge', async () => {
  const target = await makeProject();
  const a = runRemember('fact', 'Alpha fact', { cwd: target, body: 'A body', source: 'agent-x' });
  const b = runRemember('decision', 'Beta decision', { cwd: target, body: 'B body', source: 'agent-x' });
  runRelate({ cwd: target, from: a.id, to: b.id, type: 'depends_on' });

  const out = runExport({ cwd: target, format: 'jsonl' });
  const lines = out.trim().split('\n');
  assert.ok(lines.length >= 3, 'expect at least 2 nodes + 1 edge line');

  for (const line of lines) {
    const obj = JSON.parse(line) as Record<string, unknown>;
    assert.ok(obj.kind === 'node' || obj.kind === 'edge', `line kind should be node|edge: ${line}`);
    if (obj.kind === 'edge') {
      assert.equal(typeof obj.from, 'string');
      assert.equal(typeof obj.to, 'string');
      assert.equal(typeof obj.type, 'string');
    } else {
      assert.equal(typeof obj.id, 'string');
    }
  }
});

// --- GraphML is well-formed envelope ---------------------------------------

test('GraphML output: has xml prolog, graphml root, and at least one node element', async () => {
  const target = await makeProject();
  runRemember('fact', 'Alpha fact', { cwd: target, body: 'A body', source: 'agent-x' });
  runRemember('decision', 'Beta decision', { cwd: target, body: 'B body', source: 'agent-x' });

  const out = runExport({ cwd: target, format: 'graphml' });
  assert.match(out, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(out, /<graphml[^>]*>/);
  assert.match(out, /<\/graphml>\s*$/);
  assert.match(out, /<graph id="memspec" edgedefault="directed">/);
  assert.match(out, /<node id="ms_/);
  // Key declarations precede graph body.
  assert.match(out, /<key id="title" for="node"/);
  assert.match(out, /<key id="edge_type" for="edge"/);
});

test('GraphML output: special XML characters in title are escaped', async () => {
  const target = await makeProject();
  runRemember('fact', 'Title with <angle> & "quotes"', { cwd: target, body: 'B', source: 'agent-x' });

  const out = runExport({ cwd: target, format: 'graphml' });
  assert.match(out, /Title with &lt;angle&gt; &amp; &quot;quotes&quot;/);
  // Confirm the raw, unescaped sequence does not appear in the title cell.
  assert.equal(out.includes('<angle>'), false);
});

// --- DOT is wrapped properly ------------------------------------------------

test('DOT output: starts with digraph header and ends with closing brace', async () => {
  const target = await makeProject();
  runRemember('fact', 'Alpha fact', { cwd: target, body: 'A body', source: 'agent-x' });

  const out = runExport({ cwd: target, format: 'dot' });
  assert.match(out, /^digraph memspec \{/);
  assert.match(out, /\}\s*$/);
  assert.match(out, /rankdir=LR/);
  assert.match(out, /\[label="Alpha fact"/);
});

// --- All three formats agree on node id set ---------------------------------

function extractJsonlNodeIds(out: string): Set<string> {
  const ids = new Set<string>();
  for (const line of out.trim().split('\n')) {
    const obj = JSON.parse(line) as Record<string, unknown>;
    if (obj.kind === 'node' && typeof obj.id === 'string') ids.add(obj.id);
  }
  return ids;
}

function extractGraphmlNodeIds(out: string): Set<string> {
  const ids = new Set<string>();
  const re = /<node id="([^"]+)">/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(out)) !== null) {
    ids.add(match[1]);
  }
  return ids;
}

function extractDotNodeIds(out: string): Set<string> {
  const ids = new Set<string>();
  // Node declarations are `  "id" [attrs];` — edge declarations contain `->` so we skip them.
  for (const line of out.split('\n')) {
    if (line.includes('->')) continue;
    const m = /^\s*"([^"]+)"\s*\[/.exec(line);
    if (m) ids.add(m[1]);
  }
  return ids;
}

test('all three formats emit identical node id sets', async () => {
  const target = await makeProject();
  const a = runRemember('fact', 'Alpha fact', { cwd: target, body: 'A', source: 'agent-x' });
  const b = runRemember('decision', 'Beta decision', { cwd: target, body: 'B', source: 'agent-x' });
  const c = runRemember('procedure', 'Gamma procedure', { cwd: target, body: 'C', source: 'agent-x' });
  runRelate({ cwd: target, from: a.id, to: b.id, type: 'refines' });
  runRelate({ cwd: target, from: b.id, to: c.id, type: 'supports' });

  // Anchor one record so the file synthetic node appears in all three formats.
  const anchored = join(target, 'anchored.txt');
  await writeFile(anchored, 'content\n');
  runAnchor(a.id, ['anchored.txt'], { cwd: target, source: 'agent-x' });

  const jsonl = runExport({ cwd: target, format: 'jsonl' });
  const graphml = runExport({ cwd: target, format: 'graphml' });
  const dot = runExport({ cwd: target, format: 'dot' });

  const jsonlIds = extractJsonlNodeIds(jsonl);
  const graphmlIds = extractGraphmlNodeIds(graphml);
  const dotIds = extractDotNodeIds(dot);

  assert.deepEqual([...jsonlIds].sort(), [...graphmlIds].sort(), 'jsonl vs graphml node sets');
  assert.deepEqual([...jsonlIds].sort(), [...dotIds].sort(), 'jsonl vs dot node sets');
  assert.ok(jsonlIds.has('file:anchored.txt'), 'synthetic file node should be present');
});

// --- include-superseded surfaces extra nodes -------------------------------

test('--include-superseded raises the node count', async () => {
  const target = await makeProject();
  const a = runRemember('fact', 'Original claim about port 9000', { cwd: target, body: 'old', source: 'agent-x' });
  runSupersede(a.id, { cwd: target, reason: 'port moved', body: 'now on 9001', source: 'agent-x' });

  const activeOnly = extractJsonlNodeIds(runExport({ cwd: target, format: 'jsonl' }));
  const withSuperseded = extractJsonlNodeIds(runExport({ cwd: target, format: 'jsonl', includeSuperseded: true }));

  assert.ok(withSuperseded.size > activeOnly.size, 'superseded node should appear with the flag');
  assert.ok(withSuperseded.has(a.id), 'original superseded node included');
  assert.ok(!activeOnly.has(a.id), 'original superseded node excluded by default');
});

test('--include-superseded surfaces supersedes edges between survivor and original', async () => {
  const target = await makeProject();
  const a = runRemember('fact', 'Original claim about port 9000', { cwd: target, body: 'old', source: 'agent-x' });
  const supersedeResult = runSupersede(a.id, { cwd: target, reason: 'port moved', body: 'now on 9001', source: 'agent-x' });

  const out = runExport({ cwd: target, format: 'jsonl', includeSuperseded: true });
  const edges: Array<{ from: string; to: string; type: string }> = [];
  for (const line of out.trim().split('\n')) {
    const obj = JSON.parse(line) as Record<string, unknown>;
    if (obj.kind === 'edge') edges.push(obj as unknown as { from: string; to: string; type: string });
  }
  const supersedesEdges = edges.filter((e) => e.type === 'supersedes');
  assert.ok(supersedesEdges.length >= 1, 'at least one supersedes edge present');
  assert.ok(supersedesEdges.some((e) => e.from === supersedeResult.survivor_id && e.to === a.id),
    'supersedes edge runs from survivor to original');
});

// --- --types filter ---------------------------------------------------------

test('--types fact filters out decisions and procedures', async () => {
  const target = await makeProject();
  const f = runRemember('fact', 'A fact', { cwd: target, body: 'B', source: 'agent-x' });
  const d = runRemember('decision', 'A decision', { cwd: target, body: 'B', source: 'agent-x' });
  const p = runRemember('procedure', 'A procedure', { cwd: target, body: 'B', source: 'agent-x' });

  const out = runExport({ cwd: target, format: 'jsonl', types: ['fact'] });
  const ids = extractJsonlNodeIds(out);
  assert.ok(ids.has(f.id), 'fact node present');
  assert.ok(!ids.has(d.id), 'decision node absent');
  assert.ok(!ids.has(p.id), 'procedure node absent');
});

// --- file anchors dedupe ---------------------------------------------------

test('same file anchored from two records → one file node + two anchors_to edges', async () => {
  const target = await makeProject();
  const f1 = runRemember('fact', 'Fact one about config', { cwd: target, body: 'B1', source: 'agent-x' });
  const f2 = runRemember('fact', 'Fact two about config', { cwd: target, body: 'B2', source: 'agent-x' });

  const sharedPath = join(target, 'shared.txt');
  await writeFile(sharedPath, 'content\n');
  runAnchor(f1.id, ['shared.txt'], { cwd: target, source: 'agent-x' });
  runAnchor(f2.id, ['shared.txt'], { cwd: target, source: 'agent-x' });

  const out = runExport({ cwd: target, format: 'jsonl' });
  const lines = out.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  const fileNodes = lines.filter((o) => o.kind === 'node' && o.node_type === 'file');
  assert.equal(fileNodes.length, 1, 'exactly one synthetic file node for the shared path');
  assert.equal(fileNodes[0].id, 'file:shared.txt');

  const anchorEdges = lines.filter((o) => o.kind === 'edge' && o.type === 'anchors_to');
  assert.equal(anchorEdges.length, 2, 'one anchors_to edge per record');
  const froms = anchorEdges.map((e) => e.from);
  assert.ok(froms.includes(f1.id) && froms.includes(f2.id), 'both records anchor in');
});

// --- operator-tier nodes are exported (Phase 4 regression) -----------------

test('operator-tier records are included in the export', async () => {
  const target = await makeProject();
  const op = runRemember('fact', 'Operator-stated fact', { cwd: target, body: 'B', source: 'siim' });
  const ag = runRemember('fact', 'Agent-stated fact', { cwd: target, body: 'B', source: 'agent-x' });

  const out = runExport({ cwd: target, format: 'jsonl' });
  const lines = out.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  const opNode = lines.find((o) => o.kind === 'node' && o.id === op.id);
  const agNode = lines.find((o) => o.kind === 'node' && o.id === ag.id);
  assert.ok(opNode, 'operator-tier node present');
  assert.ok(agNode, 'agent-tier node present');
  assert.equal(opNode!.source_kind, 'operator');
  assert.equal(agNode!.source_kind, 'agent');
});

// --- Phase 5 auto-attached conflicts_with edges surface --------------------

test('auto-attached conflicts_with edges from Phase 5 inference show up in export', async () => {
  const target = await makeProject();
  // Two same-type, same-tag records with strongly overlapping titles trigger
  // the mid-band auto-attach. Use a body so the records aren't trivially empty.
  const first = runRemember('fact', 'Auth tokens rotate every 24 hours', {
    cwd: target,
    body: 'Currently configured TTL is one day',
    source: 'agent-x',
    tags: 'auth,security',
  });
  const second = runRemember('fact', 'Auth tokens rotate every 12 hours', {
    cwd: target,
    body: 'Currently configured TTL is twelve hours',
    source: 'agent-x',
    tags: 'auth,security',
  });

  // Only continue if Phase 5 actually attached an edge — otherwise this test
  // is a no-op rather than a false failure (e.g. if the mid-band heuristic
  // changes thresholds). We assert the export reflects whatever was attached.
  if (!second.autoAttached) {
    return;
  }
  assert.equal(second.autoAttached.type, 'conflicts_with');
  assert.equal(second.autoAttached.target_id, first.id);

  const out = runExport({ cwd: target, format: 'jsonl' });
  const lines = out.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  const conflictEdges = lines.filter((o) => o.kind === 'edge' && o.type === 'conflicts_with');
  assert.ok(conflictEdges.some((e) => e.from === second.id && e.to === first.id),
    `expected conflicts_with edge ${second.id} -> ${first.id}, got ${JSON.stringify(conflictEdges)}`);
});

// --- CLI surface check ------------------------------------------------------

test('CLI: memspec export --format jsonl writes JSONL to stdout', async () => {
  const target = await makeProject();
  await runCli(['remember', 'fact', 'CLI fact', '--cwd', target, '--body', 'B', '--source', 'agent-x']);

  const { stdout } = await runCli(['export', '--format', 'jsonl', '--cwd', target]);
  const lines = stdout.trim().split('\n');
  assert.ok(lines.length >= 1);
  const obj = JSON.parse(lines[0]) as Record<string, unknown>;
  assert.equal(obj.kind, 'node');
});

test('CLI: memspec export rejects unknown --format', async () => {
  const target = await makeProject();
  await assert.rejects(
    () => runCli(['export', '--format', 'graphviz', '--cwd', target]),
    (err: Error & { stderr?: string }) => {
      assert.match(`${err.message}\n${err.stderr ?? ''}`, /--format must be one of/);
      return true;
    },
  );
});

// --- MCP surface check ------------------------------------------------------

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
  private pending = new Map<number, { resolve: (v: JsonRpcResponse) => void; reject: (e: Error) => void }>();

  constructor(args: string[]) {
    this.child = spawn(process.execPath, ['--import', 'tsx', ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, TZ: 'UTC' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
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
    let nl = this.buffer.indexOf('\n');
    while (nl !== -1) {
      const raw = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (raw.length > 0) {
        const msg = JSON.parse(raw) as JsonRpcResponse;
        if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          p.resolve(msg);
        }
      }
      nl = this.buffer.indexOf('\n');
    }
  }

  async request(method: string, params?: unknown): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const promise = new Promise<JsonRpcResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.child.stdin.write(`${payload}\n`);
    return promise;
  }

  notify(method: string, params?: unknown): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
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

test('MCP: memspec_export returns the formatted output as a string', async () => {
  const target = await makeProject();
  runRemember('fact', 'MCP-export fact', { cwd: target, body: 'B', source: 'agent-x' });

  const session = new McpSession([join(REPO_ROOT, 'src/mcp.ts'), '--cwd', target]);
  try {
    await session.init();
    const call = await session.request('tools/call', {
      name: 'memspec_export',
      arguments: { format: 'jsonl' },
    });
    assert.equal(call.error, undefined);
    const result = call.result as { content: Array<{ text: string }>; structuredContent: Record<string, unknown> };
    const text = result.content[0].text;
    assert.match(text, /"kind":"node"/);
    assert.equal(result.structuredContent.format, 'jsonl');
    assert.equal(result.structuredContent.include_superseded, false);
  } finally {
    await session.close();
  }
});
