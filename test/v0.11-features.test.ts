import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import { makeTempProject, readText, REPO_ROOT, runCli } from './helpers.js';
import { McpSession } from './mcp-session.js';

async function initProject(): Promise<string> {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  return target;
}

async function factIds(target: string): Promise<string[]> {
  const dir = join(target, '.memspec', 'memory', 'facts');
  return (await readdir(dir)).map((f) => f.replace(/\.md$/, ''));
}

async function addFact(target: string, title: string): Promise<string> {
  await runCli(['remember', 'fact', title, '--cwd', target, '--body', 'Body', '--source', 'test']);
  const ids = await factIds(target);
  return ids[ids.length - 1];
}

async function frontmatter(target: string, subdir: string, id: string): Promise<Record<string, unknown>> {
  const path = join(target, '.memspec', subdir, `${id}.md`);
  return matter(await readText(path)).data as Record<string, unknown>;
}

// title lives in the markdown body's leading heading, not in frontmatter.
async function titleOf(target: string, subdir: string, id: string): Promise<string> {
  const path = join(target, '.memspec', subdir, `${id}.md`);
  const body = matter(await readText(path)).content;
  return body.match(/^#\s+(.+)$/m)?.[1].trim() ?? '';
}

async function initSession(session: McpSession): Promise<void> {
  await session.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'memspec-test', version: '0.0.0' },
  });
  session.notify('notifications/initialized', {});
}

// --- S2: relate wiring for derived_from ---

test('relate --type derived_from writes the edge (CLI)', async () => {
  const target = await initProject();
  const from = await addFact(target, 'Derived origin');
  const to = await addFact(target, 'Source basis');

  const out = await runCli(['relate', '--cwd', target, '--from', from, '--to', to, '--type', 'derived_from']);
  assert.match(out.stdout, /-\[derived_from\]->/);
  assert.deepEqual((await frontmatter(target, 'memory/facts', from)).derived_from, [to]);

  // unrelate removes it.
  await runCli(['unrelate', '--cwd', target, '--from', from, '--to', to, '--type', 'derived_from', '--reason', 'wrong', '--source', 'test']);
  assert.equal((await frontmatter(target, 'memory/facts', from)).derived_from, undefined);
});

test('relate refuses conflicts_with when a derived_from edge exists, and vice versa', async () => {
  const target = await initProject();
  const a = await addFact(target, 'Conflict A');
  const b = await addFact(target, 'Conflict B');

  await runCli(['relate', '--cwd', target, '--from', a, '--to', b, '--type', 'derived_from']);
  await assert.rejects(
    () => runCli(['relate', '--cwd', target, '--from', a, '--to', b, '--type', 'conflicts_with']),
    (err: Error & { stderr?: string }) => {
      assert.match(`${err.message}\n${err.stderr ?? ''}`, /already declares a positive edge \(derived_from\)/);
      return true;
    },
  );

  const c = await addFact(target, 'Conflict C');
  const d = await addFact(target, 'Conflict D');
  await runCli(['relate', '--cwd', target, '--from', c, '--to', d, '--type', 'conflicts_with']);
  await assert.rejects(
    () => runCli(['relate', '--cwd', target, '--from', c, '--to', d, '--type', 'derived_from']),
    (err: Error & { stderr?: string }) => {
      assert.match(`${err.message}\n${err.stderr ?? ''}`, /already declares conflicts_with/);
      return true;
    },
  );
});

test('remember --conflicts-with contradicting --derived-from is refused', async () => {
  const target = await initProject();
  const t = await addFact(target, 'Shared target');
  await assert.rejects(
    () => runCli(['remember', 'fact', 'Contradiction', '--cwd', target, '--source', 'test', '--body', 'B', '--derived-from', t, '--conflicts-with', t]),
    (err: Error & { stderr?: string }) => {
      assert.match(`${err.message}\n${err.stderr ?? ''}`, /contradicts a positive edge/);
      return true;
    },
  );
});

// --- S1: requires_human ---

test('remember --requires-human persists on a procedure and rejects on a fact (CLI)', async () => {
  const target = await initProject();
  await runCli(['remember', 'procedure', 'Prod deploy', '--cwd', target, '--source', 'human:siim', '--body', 'B', '--requires-human', 'approve console', 'rotate key']);
  const dir = join(target, '.memspec', 'memory', 'operator', 'procedures');
  const id = (await readdir(dir))[0].replace(/\.md$/, '');
  assert.deepEqual((await frontmatter(target, 'memory/operator/procedures', id)).requires_human, ['approve console', 'rotate key']);

  await assert.rejects(
    () => runCli(['remember', 'fact', 'bad', '--cwd', target, '--source', 'test', '--body', 'B', '--requires-human', 'nope']),
    (err: Error & { stderr?: string }) => {
      assert.match(`${err.message}\n${err.stderr ?? ''}`, /only valid on a procedure/);
      return true;
    },
  );
});

// --- S3: evidence ---

test('remember --evidence copies a file, promotes witness to evidence, records a URL (CLI)', async () => {
  const target = await initProject();
  const proof = join(target, 'proof.txt');
  await writeFile(proof, 'measured 60s');
  await runCli(['remember', 'fact', 'cache ttl', '--cwd', target, '--source', 'claude-code', '--body', 'B', '--evidence', proof, '--evidence', 'https://example.com/r']);
  const id = (await factIds(target))[0];
  const fm = await frontmatter(target, 'memory/facts', id);
  assert.equal(fm.verified_with, 'evidence');
  const evidence = fm.evidence as Array<Record<string, string>>;
  assert.equal(evidence.length, 2);
  assert.ok(evidence[0].sha256);
  assert.equal(evidence[1].url, 'https://example.com/r');
  assert.ok(existsSync(join(target, '.memspec', evidence[0].path)));
});

test('verify --evidence-file satisfies anchorless verification and attaches evidence (CLI)', async () => {
  const target = await initProject();
  const id = await addFact(target, 'Unanchored claim');
  const proof = join(target, 'check.txt');
  await writeFile(proof, 'i checked');
  const out = await runCli(['verify', id, '--cwd', target, '--evidence-file', proof, '--source', 'test']);
  assert.match(out.stdout, /verified_with: evidence/);
  const fm = await frontmatter(target, 'memory/facts', id);
  assert.equal((fm.evidence as unknown[]).length, 1);
});

// --- S4: questions ---

test('question lifecycle: create, add, close, resolve by elimination (CLI)', async () => {
  const target = await initProject();
  const a = await addFact(target, 'Answer postgres');
  const b = await addFact(target, 'Answer mysql');

  await runCli(['question', 'Which database?', '--cwd', target, '--source', 'test', '--answers', a, b, '--closed']);
  const qid = (await readdir(join(target, '.memspec', 'memory', 'questions')))[0].replace(/\.md$/, '');
  let fm = await frontmatter(target, 'memory/questions', qid);
  assert.equal(fm.kind, 'question');
  assert.equal(fm.state, 'open');
  assert.equal(fm.closed, true);
  assert.deepEqual(fm.answers, [a, b]);

  // status reports it as open with 2 candidates.
  let status = await runCli(['status', '--cwd', target]);
  assert.match(status.stdout, /## Questions/);
  assert.match(status.stdout, /open — 2 candidate/);

  // Supersede b → resolvable by elimination.
  await runCli(['supersede', b, '--cwd', target, '--reason', 'chose postgres']);
  status = await runCli(['status', '--cwd', target]);
  assert.match(status.stdout, new RegExp(`resolved by elimination — survivor ${a}`));

  // Resolve.
  const resolved = await runCli(['question', qid, '--cwd', target, '--resolve']);
  assert.match(resolved.stdout, new RegExp(`survivor ${a}`));
  fm = await frontmatter(target, 'memory/questions', qid);
  assert.equal(fm.state, 'resolved');
  assert.equal(fm.resolved_by, a);
});

test('an open-world question with one active answer is reported open, not resolvable (CLI)', async () => {
  const target = await initProject();
  const a = await addFact(target, 'Only answer');
  const b = await addFact(target, 'Other answer');
  await runCli(['question', 'Open question?', '--cwd', target, '--source', 'test', '--answers', a, b]);
  await runCli(['supersede', b, '--cwd', target, '--reason', 'gone']);
  const status = await runCli(['status', '--cwd', target]);
  assert.match(status.stdout, /open — 1 candidate/);
  assert.doesNotMatch(status.stdout, /resolved by elimination/);
});

test('remember --answers-question registers the new record on the question (CLI)', async () => {
  const target = await initProject();
  const a = await addFact(target, 'First candidate');
  await runCli(['question', 'Answered via remember?', '--cwd', target, '--source', 'test', '--answers', a]);
  const qid = (await readdir(join(target, '.memspec', 'memory', 'questions')))[0].replace(/\.md$/, '');
  await runCli(['remember', 'fact', 'Second candidate', '--cwd', target, '--source', 'test', '--body', 'B', '--answers-question', qid]);
  const newId = (await factIds(target)).find((id) => id !== a)!;
  const fm = await frontmatter(target, 'memory/questions', qid);
  assert.deepEqual(fm.answers, [a, newId]);
});

test('search --type question lists question groups, open before resolved, with closed/answers/state/resolved_by (CLI)', async () => {
  const target = await initProject();
  const a = await addFact(target, 'Search-question answer alpha A');
  const b = await addFact(target, 'Search-question answer alpha B');
  const c = await addFact(target, 'Search-question answer alpha C');

  await runCli(['question', 'Zq-alpha open question', '--cwd', target, '--source', 'test', '--answers', a]);
  await runCli(['question', 'Zq-alpha resolvable question', '--cwd', target, '--source', 'test', '--answers', b, c, '--closed']);
  const qids = (await readdir(join(target, '.memspec', 'memory', 'questions'))).map((f) => f.replace(/\.md$/, ''));
  // Resolve the second question by elimination: supersede c, leaving b as sole survivor.
  await runCli(['supersede', c, '--cwd', target, '--reason', 'chose b']);
  const resolvableQid = (await Promise.all(qids.map(async (id) => {
    const title = await titleOf(target, 'memory/questions', id);
    return { id, title };
  }))).find((q) => q.title === 'Zq-alpha resolvable question')!.id;
  await runCli(['question', resolvableQid, '--cwd', target, '--resolve']);

  const res = await runCli(['search', 'Zq-alpha', '--cwd', target, '--type', 'question', '--json']);
  const hits = JSON.parse(res.stdout) as Array<Record<string, unknown>>;
  assert.equal(hits.length, 2);
  assert.equal(hits.every((h) => h.type === 'question'), true);

  const open = hits.find((h) => h.title === 'Zq-alpha open question')!;
  assert.equal(open.state, 'open');
  assert.equal(open.closed, false);
  assert.deepEqual(open.answers, [a]);
  assert.equal('resolved_by' in open, false);

  const resolved = hits.find((h) => h.title === 'Zq-alpha resolvable question')!;
  assert.equal(resolved.state, 'resolved');
  assert.equal(resolved.closed, true);
  assert.equal(resolved.resolved_by, b);

  // Open sorts before resolved regardless of creation order.
  assert.equal(hits[0].title, 'Zq-alpha open question');
  assert.equal(hits[1].title, 'Zq-alpha resolvable question');
});

test('default search excludes question groups; --type question is the only path that returns them (CLI)', async () => {
  const target = await initProject();
  const a = await addFact(target, 'Default-search-exclusion answer');
  await runCli(['question', 'Zq-marker-unique-search-term', '--cwd', target, '--source', 'test', '--answers', a]);

  const defaultRes = await runCli(['search', 'Zq-marker-unique-search-term', '--cwd', target, '--json']);
  assert.deepEqual(JSON.parse(defaultRes.stdout), []);

  const typedRes = await runCli(['search', 'Zq-marker-unique-search-term', '--cwd', target, '--type', 'question', '--json']);
  const hits = JSON.parse(typedRes.stdout) as Array<Record<string, unknown>>;
  assert.equal(hits.length, 1);
  assert.equal(hits[0].type, 'question');
  assert.equal(hits[0].title, 'Zq-marker-unique-search-term');
});

test('MCP memspec_search type=question returns question groups; default search excludes them', async () => {
  const target = await initProject();
  const a = await addFact(target, 'Unrelated helper answer record alpha');

  const session = new McpSession([join(REPO_ROOT, 'src/mcp.ts'), '--cwd', target]);
  try {
    await initSession(session);
    await session.request('tools/call', {
      name: 'memspec_question',
      arguments: { title: 'Mcp-zq-marker question', answers: [a], source: 'mcp-test' },
    });

    const defaultRes = await session.request('tools/call', {
      name: 'memspec_search',
      arguments: { query: 'Mcp-zq-marker question' },
    });
    const defaultPayload = (defaultRes.result as { structuredContent: { results: unknown[] } }).structuredContent;
    assert.equal(defaultPayload.results.length, 0);

    const typedRes = await session.request('tools/call', {
      name: 'memspec_search',
      arguments: { query: 'Mcp-zq-marker question', type: 'question' },
    });
    const typedPayload = (typedRes.result as { structuredContent: { results: Array<Record<string, unknown>> } }).structuredContent;
    assert.equal(typedPayload.results.length, 1);
    assert.equal(typedPayload.results[0].type, 'question');
    assert.equal(typedPayload.results[0].closed, false);
    assert.deepEqual(typedPayload.results[0].answers, [a]);
  } finally {
    await session.close();
  }
});

test('MCP memspec_status structuredContent carries a questions array (parity with CLI ## Questions)', async () => {
  const target = await initProject();
  const a = await addFact(target, 'MCP-status-question answer');

  const session = new McpSession([join(REPO_ROOT, 'src/mcp.ts'), '--cwd', target]);
  try {
    await initSession(session);
    await session.request('tools/call', {
      name: 'memspec_question',
      arguments: { title: 'Mcp-status-question group', answers: [a], source: 'mcp-test' },
    });
    const statusRes = await session.request('tools/call', { name: 'memspec_status', arguments: {} });
    const structured = (statusRes.result as { structuredContent: { questions: Array<Record<string, unknown>> } }).structuredContent;
    assert.ok(Array.isArray(structured.questions));
    assert.equal(structured.questions.length, 1);
    assert.equal(structured.questions[0].title, 'Mcp-status-question group');
    assert.equal(structured.questions[0].state, 'open');
  } finally {
    await session.close();
  }
});

test('export includes question nodes, answers edges, and derived_from edges (CLI jsonl)', async () => {
  const target = await initProject();
  const a = await addFact(target, 'Export answer');
  await runCli(['remember', 'fact', 'Export derived', '--cwd', target, '--body', 'B', '--source', 'test', '--derived-from', a]);
  await runCli(['question', 'Export question?', '--cwd', target, '--source', 'test', '--answers', a]);
  const out = await runCli(['export', '--format', 'jsonl', '--cwd', target]);
  const lines = out.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.some((n) => n.node_type === 'question'));
  assert.ok(lines.some((e) => e.type === 'answers' && e.to === a));
  assert.ok(lines.some((e) => e.type === 'derived_from' && e.to === a));
});

// --- MCP surface ---

test('MCP memspec_remember carries requires_human / derived_from / evidence, and memspec_get echoes them', async () => {
  const target = await initProject();
  const basis = await addFact(target, 'MCP basis');
  const proof = join(target, 'mcp-proof.txt');
  await writeFile(proof, 'evidence for mcp');

  const session = new McpSession([join(REPO_ROOT, 'src/mcp.ts'), '--cwd', target]);
  try {
    await initSession(session);

    const proc = await session.request('tools/call', {
      name: 'memspec_remember',
      arguments: { type: 'procedure', title: 'MCP proc', body: 'B', source: 'mcp-test', requires_human: ['human step'] },
    });
    assert.equal(proc.error, undefined);
    const procId = (proc.result as { structuredContent: { id: string } }).structuredContent.id;

    const derived = await session.request('tools/call', {
      name: 'memspec_remember',
      arguments: { type: 'fact', title: 'MCP derived', body: 'B', source: 'mcp-test', derived_from: [basis], evidence: [proof] },
    });
    const dRes = (derived.result as { structuredContent: Record<string, unknown> }).structuredContent;
    assert.equal(dRes.derived, true);
    assert.ok(Array.isArray(dRes.evidence) && (dRes.evidence as unknown[]).length === 1);
    const derivedId = dRes.id as string;

    // get echoes the new fields
    const gotProc = await session.request('tools/call', { name: 'memspec_get', arguments: { id: procId } });
    const procPayload = JSON.parse((gotProc.result as { content: Array<{ text: string }> }).content[0].text);
    assert.deepEqual(procPayload.requires_human, ['human step']);

    const gotDerived = await session.request('tools/call', { name: 'memspec_get', arguments: { id: derivedId } });
    const dPayload = JSON.parse((gotDerived.result as { content: Array<{ text: string }> }).content[0].text);
    assert.equal(dPayload.derived, true);
    assert.deepEqual(dPayload.derived_from, [basis]);
    assert.equal(dPayload.verified_with, 'evidence');
    assert.equal(dPayload.evidence.length, 1);
  } finally {
    await session.close();
  }
});

test('MCP memspec_question creates and resolves a question group', async () => {
  const target = await initProject();
  const a = await addFact(target, 'MCP ans A');
  const b = await addFact(target, 'MCP ans B');

  const session = new McpSession([join(REPO_ROOT, 'src/mcp.ts'), '--cwd', target]);
  try {
    await initSession(session);

    const created = await session.request('tools/call', {
      name: 'memspec_question',
      arguments: { title: 'MCP which?', answers: [a, b], closed: true, source: 'mcp-test' },
    });
    assert.equal(created.error, undefined);
    const qid = (created.result as { structuredContent: { id: string; closed: boolean } }).structuredContent.id;
    assert.equal((created.result as { structuredContent: { closed: boolean } }).structuredContent.closed, true);

    // Supersede b via CLI, then resolve over MCP.
    await runCli(['supersede', b, '--cwd', target, '--reason', 'chose a']);
    const resolved = await session.request('tools/call', {
      name: 'memspec_question',
      arguments: { id: qid, resolve: true },
    });
    assert.equal(resolved.error, undefined);
    const rRes = (resolved.result as { structuredContent: { state: string; survivor: string } }).structuredContent;
    assert.equal(rRes.state, 'resolved');
    assert.equal(rRes.survivor, a);
  } finally {
    await session.close();
  }
});

test('MCP memspec_verify accepts evidence_file for an anchorless record', async () => {
  const target = await initProject();
  const id = await addFact(target, 'MCP verify target');
  const proof = join(target, 'mcp-verify.txt');
  await writeFile(proof, 'checked over mcp');

  const session = new McpSession([join(REPO_ROOT, 'src/mcp.ts'), '--cwd', target]);
  try {
    await initSession(session);
    const res = await session.request('tools/call', {
      name: 'memspec_verify',
      arguments: { id, evidence_file: proof, source: 'mcp-test' },
    });
    assert.equal(res.error, undefined);
    const structured = (res.result as { structuredContent: { verified_with: string } }).structuredContent;
    assert.equal(structured.verified_with, 'evidence');
    const fm = matter(await readFile(join(target, '.memspec', 'memory', 'facts', `${id}.md`), 'utf8')).data as Record<string, unknown>;
    assert.equal((fm.evidence as unknown[]).length, 1);
  } finally {
    await session.close();
  }
});

test('status reports the evidence-backed count (CLI)', async () => {
  const target = await initProject();
  const proof = join(target, 'ev.txt');
  await writeFile(proof, 'x');
  await runCli(['remember', 'fact', 'Evidence backed', '--cwd', target, '--source', 'test', '--body', 'B', '--evidence', proof]);
  const status = await runCli(['status', '--cwd', target]);
  assert.match(status.stdout, /1 active record\(s\) backed by committed evidence/);
});
