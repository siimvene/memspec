import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { makeTempProject, REPO_ROOT, runCli } from './helpers.js';
import { searchPayload } from '../src/commands/search.js';
import { runContext } from '../src/commands/context.js';
import { runRemember } from '../src/commands/remember.js';
import { CompositeStore } from '../src/lib/composite-store.js';
import { MemspecStore } from '../src/lib/store.js';

/**
 * v0.6.1 regression coverage for issue #2 — the `stores:` config block was
 * silently ignored by every retrieval path (search, context, MCP search, MCP
 * get) because each constructed a single `MemspecStore` instead of wrapping in
 * `CompositeStore`. Reported and root-caused by Mika Tsernobrivoi (@KongFuzi1).
 */

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
    this.child.stderr.on('data', () => {
      // drain
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

/**
 * Build the exact two-store setup from issue #2: a read-only central layer and
 * a writable project layer pointed at it via the `stores:` config block.
 * Returns the project cwd plus the id of the central record so callers can
 * assert id-based retrieval.
 */
async function makeLayeredProjects(): Promise<{
  central: string;
  project: string;
  centralId: string;
}> {
  const central = await makeTempProject();
  const project = await makeTempProject();

  await runCli(['init', '--cwd', central, '--no-interactive', '--no-install-hooks']);
  await runCli(['init', '--cwd', project, '--no-interactive', '--no-install-hooks']);

  const remembered = runRemember('fact', 'Engine talks to MariaDB', {
    cwd: central,
    body: 'Central layer fact written before any project search.',
    source: 'eval',
  });

  const centralPath = join(central, '.memspec');
  const config = [
    'stores:',
    '  - name: central',
    `    path: ${centralPath}`,
    '    priority: 0',
    '    writable: false',
    '  - name: project',
    '    path: .memspec',
    '    priority: 10',
    '    writable: true',
    '',
  ].join('\n');
  await writeFile(join(project, '.memspec', 'config.yaml'), config, 'utf8');

  return { central, project, centralId: remembered.id };
}

// --- searchPayload (CLI / MCP shared core) -----------------------------------

test('searchPayload surfaces records from configured lower-priority layers (#2 repro)', async () => {
  const { project } = await makeLayeredProjects();
  const payload = searchPayload('MariaDB', { cwd: project });
  assert.equal(payload.count, 1, 'central layer record must be surfaced');
  assert.equal(payload.results[0]?.title, 'Engine talks to MariaDB');
});

test('searchPayload without stores: config behaves identically to v0.6 single-store', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target, '--no-interactive', '--no-install-hooks']);
  runRemember('fact', 'Project-only fact', {
    cwd: target,
    body: 'No layering configured.',
    source: 'test',
  });

  const payload = searchPayload('Project-only', { cwd: target });
  assert.equal(payload.count, 1);
  assert.equal(payload.results[0]?.title, 'Project-only fact');
});

test('higher-priority layer wins when both stores hold a matching record', async () => {
  const { central, project } = await makeLayeredProjects();

  // Write a competing claim into the project layer with overlapping content.
  runRemember('fact', 'Engine talks to MariaDB', {
    cwd: project,
    body: 'Project override — newer and higher priority.',
    source: 'test',
  });

  const payload = searchPayload('MariaDB', { cwd: project });
  assert.ok(payload.count >= 1, 'both layers contributed');

  const top = payload.results[0];
  assert.ok(top, 'at least one result expected');
  // The project store lives under the project cwd; central lives under the
  // central cwd. The first hit must be the project-layer record.
  const projectStoreRoot = new MemspecStore(project).root;
  const item = new CompositeStore(
    [
      { name: 'project', path: '.memspec', priority: 10, writable: true },
    ],
    project,
  ).findById(top.id);
  assert.ok(item, 'top hit must be findable in the higher-priority layer');
  assert.ok(item.filePath.startsWith(projectStoreRoot), `top hit must come from ${projectStoreRoot}`);
});

// --- context (boot list) -----------------------------------------------------

test('runContext surfaces records from layered stores', async () => {
  const { project } = await makeLayeredProjects();
  const out = runContext({ cwd: project });
  assert.match(out, /Engine talks to MariaDB/);
});

// --- writable: false layer routing ------------------------------------------

test('writing to a read-only layer is rejected; default routes to writable layer', async () => {
  const { project, central } = await makeLayeredProjects();
  const store = CompositeStore.forCwd(project);

  const frontmatter = (id: string, title: string) => ({
    id,
    title,
    body: 'test body',
    kind: 'claim' as const,
    type: 'fact' as const,
    source: 'test',
    source_kind: 'agent' as const,
    tags: [],
    created: new Date().toISOString(),
    last_verified: new Date().toISOString(),
    check_by: 'never',
    verified_with: 'assertion' as const,
    state: 'active' as const,
  });

  // Explicit writes to a writable:false layer must be rejected.
  const rejectedId = `ms_${ulid()}`;
  assert.throws(
    () => store.writeItem(frontmatter(rejectedId, 'rejected'), 'central'),
    /not writable/,
  );

  // Default target picks the writable (project) layer.
  const routedId = `ms_${ulid()}`;
  const writtenPath = store.writeItem(frontmatter(routedId, 'Routed to project'));

  const projectStore = new MemspecStore(project);
  const centralStore = new MemspecStore(central);
  assert.ok(writtenPath.startsWith(projectStore.root), `expected write under ${projectStore.root}, got ${writtenPath}`);
  assert.ok(projectStore.findById(routedId), 'record must land in the writable project layer');
  assert.equal(centralStore.findById(routedId), null, 'central layer must not receive the write');
});

// --- MCP surface (the bug Mika filed against) -------------------------------

test('mcp memspec_search honors layered stores (#2 — MCP regression guard)', async () => {
  const { project } = await makeLayeredProjects();

  const session = new McpSession([join(REPO_ROOT, 'src/mcp.ts'), '--cwd', project]);
  try {
    await session.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'memspec-layered-test', version: '0.0.0' },
    });
    session.notify('notifications/initialized', {});

    const call = await session.request('tools/call', {
      name: 'memspec_search',
      arguments: { query: 'MariaDB', limit: 5 },
    });

    assert.equal(call.error, undefined);
    const result = call.result as {
      structuredContent?: { results?: Array<{ title: string }> };
    };
    assert.ok(result.structuredContent);
    assert.equal(result.structuredContent?.results?.length, 1);
    assert.equal(result.structuredContent?.results?.[0]?.title, 'Engine talks to MariaDB');
  } finally {
    await session.close();
  }
});

test('mcp memspec_get finds records across layers by id', async () => {
  const { project, centralId } = await makeLayeredProjects();

  const session = new McpSession([join(REPO_ROOT, 'src/mcp.ts'), '--cwd', project]);
  try {
    await session.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'memspec-layered-test', version: '0.0.0' },
    });
    session.notify('notifications/initialized', {});

    const call = await session.request('tools/call', {
      name: 'memspec_get',
      arguments: { id: centralId },
    });

    assert.equal(call.error, undefined);
    const result = call.result as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0].text) as { id: string; title: string };
    assert.equal(parsed.id, centralId);
    assert.equal(parsed.title, 'Engine talks to MariaDB');
  } finally {
    await session.close();
  }
});
