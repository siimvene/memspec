/**
 * v0.5 Phase 2 — temporal validity intervals.
 *
 * Validity (`valid_from` / `valid_to`) bounds the world-state truth window
 * of a record. It is orthogonal to `check_by` (staleness review schedule):
 * a record can be currently valid but past check_by, or past valid_to but
 * not yet past check_by. The `as_of` search filter selects records by
 * validity window membership; staleness is not affected.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { searchPayload, isValidAsOf } from '../src/commands/search.js';
import { parseMemoryFile, serializeMemoryFile } from '../src/lib/frontmatter.js';
import { validateFrontmatter } from '../src/lib/schema.js';
import { MemspecStore } from '../src/lib/store.js';
import { makeTempProject, runCli, REPO_ROOT } from './helpers.js';
import type { MemoryItem } from '../src/lib/types.js';

const A_VALID_ID = 'ms_01HXK7Y3P5QZJKM8N4R2T6W9VB';

function baseFrontmatter(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: A_VALID_ID,
    kind: 'claim',
    type: 'fact',
    state: 'active',
    created: '2026-01-01T00:00:00Z',
    source: 'test',
    tags: [],
    check_by: 'never',
    ...overrides,
  };
}

function makeItem(overrides: Partial<MemoryItem>): MemoryItem {
  return {
    id: A_VALID_ID,
    kind: 'claim',
    type: 'fact',
    state: 'active',
    created: '2026-01-01T00:00:00Z',
    source: 'test',
    tags: [],
    check_by: 'never',
    title: 'Test',
    body: 'Body',
    filePath: '/tmp/fake.md',
    ...overrides,
  };
}

// --- Round-trip (2.7 scenario 1) ----------------------------------------

test('round-trip: valid_from and valid_to survive serialize/parse', () => {
  const serialized = serializeMemoryFile({
    id: A_VALID_ID,
    kind: 'claim',
    type: 'fact',
    state: 'active',
    created: '2026-01-01T00:00:00Z',
    source: 'test',
    tags: [],
    check_by: 'never',
    valid_from: '2026-02-01T00:00:00Z',
    valid_to: '2026-04-01T00:00:00Z',
    title: 'Has validity bounds',
    body: 'Body.',
  });

  assert.match(serialized, /valid_from: '?2026-02-01T00:00:00Z'?/);
  assert.match(serialized, /valid_to: '?2026-04-01T00:00:00Z'?/);

  const parsed = parseMemoryFile(serialized, '/dev/null');
  assert.equal(parsed.valid_from, '2026-02-01T00:00:00Z');
  assert.equal(parsed.valid_to, '2026-04-01T00:00:00Z');
});

test('writer omits valid_from/valid_to when absent (no `valid_from:` line in output)', () => {
  const serialized = serializeMemoryFile({
    id: A_VALID_ID,
    kind: 'claim',
    type: 'fact',
    state: 'active',
    created: '2026-01-01T00:00:00Z',
    source: 'test',
    tags: [],
    check_by: 'never',
    title: 'No validity',
    body: 'Body.',
  });
  assert.equal(/^valid_from:/m.test(serialized), false);
  assert.equal(/^valid_to:/m.test(serialized), false);
});

// --- isValidAsOf logic (2.4 scenarios 2-7) -------------------------------

test('as_of in the middle of the window keeps the record', () => {
  const item = makeItem({
    valid_from: '2026-02-01T00:00:00Z',
    valid_to: '2026-04-01T00:00:00Z',
  });
  assert.equal(isValidAsOf(item, new Date('2026-03-15T12:00:00Z')), true);
});

test('as_of before valid_from drops the record', () => {
  const item = makeItem({
    valid_from: '2026-02-01T00:00:00Z',
    valid_to: '2026-04-01T00:00:00Z',
  });
  assert.equal(isValidAsOf(item, new Date('2026-01-15T00:00:00Z')), false);
});

test('as_of after valid_to drops the record', () => {
  const item = makeItem({
    valid_from: '2026-02-01T00:00:00Z',
    valid_to: '2026-04-01T00:00:00Z',
  });
  assert.equal(isValidAsOf(item, new Date('2026-05-15T00:00:00Z')), false);
});

test('missing valid_from (no lower bound): record returned for any as_of <= valid_to', () => {
  const item = makeItem({ valid_to: '2026-04-01T00:00:00Z' });
  // Distant past — still inside the open-ended lower bound.
  assert.equal(isValidAsOf(item, new Date('1970-01-01T00:00:00Z')), true);
  // Just before valid_to.
  assert.equal(isValidAsOf(item, new Date('2026-03-31T23:59:59Z')), true);
  // After valid_to — dropped.
  assert.equal(isValidAsOf(item, new Date('2026-04-02T00:00:00Z')), false);
});

test('missing valid_to (no upper bound): record returned for any as_of >= valid_from', () => {
  const item = makeItem({ valid_from: '2026-02-01T00:00:00Z' });
  // Before valid_from — dropped.
  assert.equal(isValidAsOf(item, new Date('2026-01-15T00:00:00Z')), false);
  // After valid_from.
  assert.equal(isValidAsOf(item, new Date('2026-03-15T00:00:00Z')), true);
  // Distant future — still inside the open-ended upper bound.
  assert.equal(isValidAsOf(item, new Date('2099-12-31T00:00:00Z')), true);
});

test('both bounds missing: record always returned (no validity = always valid)', () => {
  const item = makeItem({});
  assert.equal(isValidAsOf(item, new Date('1970-01-01T00:00:00Z')), true);
  assert.equal(isValidAsOf(item, new Date('2026-06-29T00:00:00Z')), true);
  assert.equal(isValidAsOf(item, new Date('2099-12-31T00:00:00Z')), true);
});

// --- Boundary conditions ------------------------------------------------

test('as_of equal to valid_from keeps the record (inclusive lower bound)', () => {
  const item = makeItem({
    valid_from: '2026-02-01T00:00:00Z',
    valid_to: '2026-04-01T00:00:00Z',
  });
  assert.equal(isValidAsOf(item, new Date('2026-02-01T00:00:00Z')), true);
});

test('as_of equal to valid_to keeps the record (inclusive upper bound)', () => {
  const item = makeItem({
    valid_from: '2026-02-01T00:00:00Z',
    valid_to: '2026-04-01T00:00:00Z',
  });
  assert.equal(isValidAsOf(item, new Date('2026-04-01T00:00:00Z')), true);
});

// --- Validity vs check_by orthogonality (2.7) ----------------------------

test('validity and check_by are independent: past valid_to does not flag stale', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  await runCli([
    'remember', 'fact', 'API rate limit 1000rpm',
    '--cwd', target,
    '--source', 'test',
    '--body', 'API rate limit was 1000 rpm in Q1 2026',
    '--check-by', '2099-01-01T00:00:00Z',     // future review
    '--valid-from', '2026-01-01T00:00:00Z',
    '--valid-to', '2026-03-31T23:59:59Z',     // already expired by 2026-06-29
  ]);

  // No as_of filter — record surfaces and is NOT flagged stale (check_by is far in the future).
  const allHits = searchPayload('rate limit', { cwd: target, limit: 10 });
  assert.equal(allHits.results.length, 1);
  assert.equal(allHits.results[0].stale, false, 'past valid_to must not flag stale — check_by is future');

  // as_of inside the validity window — record surfaces.
  const insideHits = searchPayload('rate limit', { cwd: target, limit: 10, asOf: '2026-02-15T00:00:00Z' });
  assert.equal(insideHits.results.length, 1);
  assert.equal(insideHits.results[0].stale, false);

  // as_of after valid_to — record dropped by the temporal filter, even though check_by is future.
  const outsideHits = searchPayload('rate limit', { cwd: target, limit: 10, asOf: '2026-06-29T00:00:00Z' });
  assert.equal(outsideHits.results.length, 0, 'past valid_to must be excluded by as_of filter');
});

// --- Schema validation --------------------------------------------------

test('schema rejects invalid ISO8601 in valid_from', () => {
  const result = validateFrontmatter(baseFrontmatter({ valid_from: 'not-a-date' }));
  assert.equal(result.success, false);
  if (!result.success) {
    assert.ok(result.errors.some((e) => e.includes('valid_from')), `expected valid_from error, got: ${result.errors.join('; ')}`);
  }
});

test('schema rejects invalid ISO8601 in valid_to', () => {
  const result = validateFrontmatter(baseFrontmatter({ valid_to: '2026-13-45T99:99:99' }));
  assert.equal(result.success, false);
  if (!result.success) {
    assert.ok(result.errors.some((e) => e.includes('valid_to')), `expected valid_to error, got: ${result.errors.join('; ')}`);
  }
});

test('schema accepts well-formed ISO8601 in both validity fields', () => {
  const result = validateFrontmatter(baseFrontmatter({
    valid_from: '2026-02-01T00:00:00Z',
    valid_to: '2026-04-01T00:00:00.000Z',
  }));
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.valid_from, '2026-02-01T00:00:00Z');
    assert.equal(result.data.valid_to, '2026-04-01T00:00:00.000Z');
  }
});

test('backward-compat: v0.4 records without validity fields validate cleanly', () => {
  const result = validateFrontmatter(baseFrontmatter());
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.valid_from, undefined);
    assert.equal(result.data.valid_to, undefined);
  }
});

// --- CLI integration ----------------------------------------------------

test('CLI: memspec search --as-of filters by validity window', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  await runCli([
    'remember', 'fact', 'JWT Q1 2026 secret rotated',
    '--cwd', target, '--source', 'test',
    '--valid-from', '2026-01-01T00:00:00Z',
    '--valid-to', '2026-03-31T23:59:59Z',
  ]);
  await runCli([
    'remember', 'fact', 'JWT current secret eternal',
    '--cwd', target, '--source', 'test',
    // no validity bounds — always valid
  ]);

  // as_of inside Q1: both surface (eternal record has no bounds, Q1 record is in window).
  const q1 = await runCli(['search', 'JWT', '--cwd', target, '--as-of', '2026-02-15T00:00:00Z', '--json']);
  const q1Json = JSON.parse(q1.stdout) as Array<{ title: string }>;
  assert.equal(q1Json.length, 2);

  // as_of after Q1: only the eternal record surfaces.
  const q3 = await runCli(['search', 'JWT', '--cwd', target, '--as-of', '2026-06-29T00:00:00Z', '--json']);
  const q3Json = JSON.parse(q3.stdout) as Array<{ title: string }>;
  assert.equal(q3Json.length, 1);
  assert.equal(q3Json[0].title, 'JWT current secret eternal');
});

test('CLI: memspec remember --valid-from --valid-to writes fields to frontmatter', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  await runCli([
    'remember', 'fact', 'Has validity bounds',
    '--cwd', target, '--source', 'test',
    '--valid-from', '2026-02-01T00:00:00Z',
    '--valid-to', '2026-04-01T00:00:00Z',
  ]);

  const store = new MemspecStore(target);
  const items = store.loadAll();
  assert.equal(items.length, 1);
  assert.equal(items[0].valid_from, '2026-02-01T00:00:00Z');
  assert.equal(items[0].valid_to, '2026-04-01T00:00:00Z');
});

test('CLI: invalid --valid-from is rejected at write time', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  await assert.rejects(
    () => runCli([
      'remember', 'fact', 'Bad date',
      '--cwd', target, '--source', 'test',
      '--valid-from', 'not-a-date',
    ]),
    (err: Error & { stderr?: string }) => {
      const msg = `${err.message}\n${err.stderr ?? ''}`;
      assert.match(msg, /valid_from/);
      return true;
    },
  );
});

test('CLI: --valid-from later than --valid-to is rejected', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  await assert.rejects(
    () => runCli([
      'remember', 'fact', 'Backwards window',
      '--cwd', target, '--source', 'test',
      '--valid-from', '2026-04-01T00:00:00Z',
      '--valid-to', '2026-02-01T00:00:00Z',
    ]),
    (err: Error & { stderr?: string }) => {
      const msg = `${err.message}\n${err.stderr ?? ''}`;
      assert.match(msg, /valid_from .* <= valid_to/);
      return true;
    },
  );
});

test('search throws on invalid as_of string', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  assert.throws(
    () => searchPayload('anything', { cwd: target, asOf: 'not-a-date' }),
    /Invalid as_of timestamp/,
  );
});

// --- MCP integration ----------------------------------------------------

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
      { cwd: REPO_ROOT, env: { ...process.env, TZ: 'UTC' }, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      this.flushBuffer();
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', () => {});
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
}

test('MCP: memspec_search with as_of filters by validity window', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  await runCli([
    'remember', 'fact', 'API key 2026 Q1',
    '--cwd', target, '--source', 'test',
    '--valid-from', '2026-01-01T00:00:00Z',
    '--valid-to', '2026-03-31T23:59:59Z',
  ]);
  await runCli(['remember', 'fact', 'API key current', '--cwd', target, '--source', 'test']);

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
      arguments: { query: 'API key', as_of: '2026-06-29T00:00:00Z' },
    });
    assert.equal(call.error, undefined);
    const result = call.result as {
      structuredContent?: { results?: Array<{ title: string }> };
    };
    const titles = (result.structuredContent?.results ?? []).map((r) => r.title);
    assert.equal(titles.length, 1);
    assert.equal(titles[0], 'API key current');
  } finally {
    await session.close();
  }
});

test('MCP: memspec_remember accepts valid_from / valid_to and memspec_get returns them', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);

  const session = new McpSession([join(REPO_ROOT, 'src/mcp.ts'), '--cwd', target]);
  try {
    await session.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'memspec-test', version: '0.0.0' },
    });
    session.notify('notifications/initialized', {});

    const remember = await session.request('tools/call', {
      name: 'memspec_remember',
      arguments: {
        type: 'fact',
        title: 'Validity-bounded fact',
        body: 'Body.',
        source: 'mcp-test',
        valid_from: '2026-02-01T00:00:00Z',
        valid_to: '2026-04-01T00:00:00Z',
      },
    });
    assert.equal(remember.error, undefined);
    const rememberResult = remember.result as { structuredContent: { id: string } };
    const id = rememberResult.structuredContent.id;

    const get = await session.request('tools/call', {
      name: 'memspec_get',
      arguments: { id },
    });
    assert.equal(get.error, undefined);
    const getResult = get.result as { content: Array<{ text: string }> };
    const parsed = JSON.parse(getResult.content[0].text) as { valid_from?: string; valid_to?: string };
    assert.equal(parsed.valid_from, '2026-02-01T00:00:00Z');
    assert.equal(parsed.valid_to, '2026-04-01T00:00:00Z');
  } finally {
    await session.close();
  }
});
