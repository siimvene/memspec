import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeTempProject, REPO_ROOT, runCli } from './helpers.js';
import { McpSession } from './mcp-session.js';

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

    // v0.11 surface (14 tools): v0.10 base (12) + memspec_outcome (usage
    // receipt outcomes) + memspec_question (question groups). Phase 7 removed
    // the memspec_add / memspec_correct shims.
    assert.deepEqual(toolNames, [
      'memspec_anchor',
      'memspec_export',
      'memspec_get',
      'memspec_observe',
      'memspec_outcome',
      'memspec_question',
      'memspec_reconcile',
      'memspec_relate',
      'memspec_remember',
      'memspec_search',
      'memspec_status',
      'memspec_supersede',
      'memspec_unrelate',
      'memspec_verify',
    ]);

    // Phase 7 — verify the removed shims are gone from the tool list.
    assert.equal(toolNames.includes('memspec_add'), false);
    assert.equal(toolNames.includes('memspec_correct'), false);

    const rememberTool = tools.find((tool) => tool.name === 'memspec_remember');
    assert.ok(rememberTool?.description?.includes('anchor it now'));

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
    'remember',
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
    'remember',
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
  await runCli(['remember', 'fact', 'Status test item', '--cwd', target, '--source', 'test']);

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

test('mcp search tool returns coverage, coverage_witness and drifted', async () => {
  const { writeFile } = await import('node:fs/promises');
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  await writeFile(join(target, 'engine.ts'), 'export const e = 1;\n');
  await runCli([
    'remember', 'fact', 'Engine constant is exported', '--cwd', target,
    '--body', 'engine exports e', '--source', 'test', '--anchor', 'engine.ts',
  ]);
  // Drift the anchored file so the read path must flag it.
  await writeFile(join(target, 'engine.ts'), 'export const e = 2; // changed\n');

  const session = new McpSession([join(REPO_ROOT, 'src/mcp.ts'), '--cwd', target]);
  try {
    await session.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'memspec-test', version: '0.0.0' },
    });
    session.notify('notifications/initialized', {});

    const hit = await session.request('tools/call', {
      name: 'memspec_search',
      arguments: { query: 'engine constant', limit: 5 },
    });
    assert.equal(hit.error, undefined);
    const sc = (hit.result as { structuredContent?: {
      coverage?: string; coverage_witness?: string | null;
      results?: Array<{ drifted?: boolean; anchor_unchecked?: boolean }>;
    } }).structuredContent;
    assert.ok(sc);
    assert.equal(sc?.coverage, 'ok');
    assert.equal(sc?.coverage_witness, 'anchor');
    assert.equal(sc?.results?.[0]?.drifted, true);

    const miss = await session.request('tools/call', {
      name: 'memspec_search',
      arguments: { query: 'kubernetes helm nonexistent', limit: 5 },
    });
    const missSc = (miss.result as { structuredContent?: { coverage?: string; coverage_witness?: string | null } }).structuredContent;
    assert.equal(missSc?.coverage, 'none');
    assert.equal(missSc?.coverage_witness, null);
  } finally {
    await session.close();
  }
});

test('mcp remember tool records a cross-repo anchor via anchor_root', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const base = await makeTempProject();
  const project = join(base, 'project');
  const lib = join(base, 'lib-repo');
  await mkdir(project, { recursive: true });
  await mkdir(join(lib, '.git'), { recursive: true });
  await writeFile(join(lib, 'index.ts'), 'export const v = 1;\n');
  await runCli(['init', '--cwd', project]);

  const session = new McpSession([join(REPO_ROOT, 'src/mcp.ts'), '--cwd', project]);
  try {
    await session.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'memspec-test', version: '0.0.0' },
    });
    session.notify('notifications/initialized', {});

    const call = await session.request('tools/call', {
      name: 'memspec_remember',
      arguments: {
        type: 'fact',
        title: 'Lib exports v',
        body: 'entry point',
        source: 'mcp-test',
        anchors: ['index.ts'],
        anchor_root: lib,
      },
    });
    assert.equal(call.error, undefined);
    const sc = (call.result as { structuredContent?: {
      verified_with?: string;
      anchor_warnings?: string[];
      anchors?: Array<{ file: string; repo?: string }>;
    } }).structuredContent;
    assert.ok(sc);
    assert.equal(sc?.verified_with, 'anchor');
    assert.deepEqual(sc?.anchor_warnings, []);
    assert.equal(sc?.anchors?.[0]?.file, 'index.ts');
    assert.equal(sc?.anchors?.[0]?.repo, 'lib-repo');
  } finally {
    await session.close();
  }
});

test('mcp remember tool warns actionably when an anchor resolves nowhere', async () => {
  const project = await makeTempProject();
  await runCli(['init', '--cwd', project]);
  const session = new McpSession([join(REPO_ROOT, 'src/mcp.ts'), '--cwd', project]);
  try {
    await session.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'memspec-test', version: '0.0.0' },
    });
    session.notify('notifications/initialized', {});

    const call = await session.request('tools/call', {
      name: 'memspec_remember',
      arguments: { type: 'fact', title: 'No anchor', body: 'x', source: 'mcp-test', anchors: ['nope.ts'] },
    });
    const sc = (call.result as { structuredContent?: { verified_with?: string; anchor_warnings?: string[] } }).structuredContent;
    assert.equal(sc?.verified_with, 'assertion');
    assert.equal(sc?.anchor_warnings?.length, 1);
    assert.match(sc?.anchor_warnings?.[0] ?? '', /pass an absolute path or anchor_root/);
  } finally {
    await session.close();
  }
});
