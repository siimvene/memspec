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

test('question --add that flips a resolved question back to open says "reopened" (CLI)', async () => {
  const target = await initProject();
  const a = await addFact(target, 'Reopen answer one');
  const b = await addFact(target, 'Reopen answer two');
  await runCli(['question', 'Which one reopens?', '--cwd', target, '--source', 'test', '--answers', a, b, '--closed']);
  const qid = (await readdir(join(target, '.memspec', 'memory', 'questions')))[0].replace(/\.md$/, '');
  await runCli(['supersede', b, '--cwd', target, '--reason', 'chose a']);
  await runCli(['question', qid, '--cwd', target, '--resolve']);
  let fm = await frontmatter(target, 'memory/questions', qid);
  assert.equal(fm.state, 'resolved');

  const c = await addFact(target, 'Reopen answer three');
  const added = await runCli(['question', qid, '--cwd', target, '--add', c]);
  assert.match(added.stdout, /reopened/);
  fm = await frontmatter(target, 'memory/questions', qid);
  assert.equal(fm.state, 'open');
  assert.equal(fm.resolved_by, undefined);

  // Adding an answer that does NOT touch a resolved question's state (the
  // ordinary case) must not say "reopened".
  const d = await addFact(target, 'Ordinary add answer');
  await runCli(['question', 'Ordinary add question?', '--cwd', target, '--source', 'test', '--answers', c]);
  const qid2 = (await readdir(join(target, '.memspec', 'memory', 'questions'))).map((f) => f.replace(/\.md$/, '')).find((id) => id !== qid)!;
  const ordinaryAdd = await runCli(['question', qid2, '--cwd', target, '--add', d]);
  assert.doesNotMatch(ordinaryAdd.stdout, /reopened/);
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
  const hits = JSON.parse(res.stdout).results as Array<Record<string, unknown>>;
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
  assert.deepEqual(JSON.parse(defaultRes.stdout).results, []);

  const typedRes = await runCli(['search', 'Zq-marker-unique-search-term', '--cwd', target, '--type', 'question', '--json']);
  const hits = JSON.parse(typedRes.stdout).results as Array<Record<string, unknown>>;
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

// --- Panel remediation: #15/#21, #31/#38, #39, #41, #42, #11, #29, #34 -----

async function evidenceFiles(target: string): Promise<string[]> {
  const dir = join(target, '.memspec', 'evidence');
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const sub of await readdir(dir)) out.push(...(await readdir(join(dir, sub))).map((f) => `${sub}/${f}`));
  return out;
}

function rejectsWith(pattern: RegExp) {
  return (err: Error & { stderr?: string }) => {
    assert.match(`${err.message}\n${err.stderr ?? ''}`, pattern);
    return true;
  };
}

test('#15/#21: remember --answers-question with a bad id writes nothing and the retry is not a duplicate', async () => {
  const target = await initProject();
  const a = await addFact(target, 'Real answer');
  await runCli(['question', 'Validated first?', '--cwd', target, '--source', 'test', '--answers', a]);
  const qid = (await readdir(join(target, '.memspec', 'memory', 'questions')))[0].replace(/\.md$/, '');
  const before = (await factIds(target)).length;

  await assert.rejects(
    () => runCli(['remember', 'fact', 'Orphan candidate', '--cwd', target, '--source', 'test', '--body', 'B', '--answers-question', 'ms_TYPO']),
    rejectsWith(/Question not found: ms_TYPO/),
  );
  await assert.rejects(
    () => runCli(['remember', 'fact', 'Orphan candidate', '--cwd', target, '--source', 'test', '--body', 'B', '--answers-question', a]),
    rejectsWith(/is a claim, not a question/),
  );
  assert.equal((await factIds(target)).length, before, 'no record was written on either failure');

  // The retry with the right id succeeds — no near-duplicate refusal.
  const ok = await runCli(['remember', 'fact', 'Orphan candidate', '--cwd', target, '--source', 'test', '--body', 'B', '--answers-question', qid]);
  assert.match(ok.stdout, new RegExp(`Answered question: ${qid}`));
});

test('#24: remember --answers-question into a resolved question reopens it and says so', async () => {
  const target = await initProject();
  const a = await addFact(target, 'Winner');
  const b = await addFact(target, 'Loser');
  await runCli(['question', 'Reopen via remember?', '--cwd', target, '--source', 'test', '--answers', a, b, '--closed']);
  const qid = (await readdir(join(target, '.memspec', 'memory', 'questions')))[0].replace(/\.md$/, '');
  await runCli(['supersede', b, '--cwd', target, '--reason', 'lost']);
  await runCli(['question', qid, '--cwd', target, '--resolve']);
  assert.equal((await frontmatter(target, 'memory/questions', qid)).state, 'resolved');

  const out = await runCli(['remember', 'fact', 'Late challenger', '--cwd', target, '--source', 'test', '--body', 'B', '--answers-question', qid]);
  assert.match(out.stdout, /REOPENED/);
  const fm = await frontmatter(target, 'memory/questions', qid);
  assert.equal(fm.state, 'open');
  assert.equal(fm.resolved_by, undefined);
  const status = await runCli(['status', '--cwd', target]);
  assert.match(status.stdout, /open — 2 candidate/);
});

test('#31/#38: verify --evidence-file copies nothing when the result is needs_review', async () => {
  const target = await initProject();
  await writeFile(join(target, 'code.ts'), 'v1\n');
  await runCli(['remember', 'fact', 'Anchored then drifted', '--cwd', target, '--source', 'test', '--body', 'B', '--anchor', 'code.ts']);
  const id = (await factIds(target))[0];
  await writeFile(join(target, 'code.ts'), 'v2 changed\n');
  const proof = join(target, 'proof.txt');
  await writeFile(proof, 'i looked');

  // needs_review exits 1 on the CLI, so the call rejects; the report is on stdout.
  await assert.rejects(
    () => runCli(['verify', id, '--cwd', target, '--evidence-file', proof, '--source', 'test']),
    (err: Error & { stdout?: string }) => {
      assert.match(err.stdout ?? '', /NEEDS REVIEW/);
      assert.match(err.stdout ?? '', /Memory left untouched/);
      return true;
    },
  );
  assert.deepEqual(await evidenceFiles(target), [], 'no orphan under evidence/');
  assert.equal((await frontmatter(target, 'memory/facts', id)).evidence, undefined);

  // Re-anchor, then the same verify copies and attaches.
  await runCli(['anchor', id, 'code.ts', '--cwd', target]);
  const ok = await runCli(['verify', id, '--cwd', target, '--evidence-file', proof, '--source', 'test']);
  assert.match(ok.stdout, /Verified/);
  assert.equal((await evidenceFiles(target)).length, 1);
  assert.equal(((await frontmatter(target, 'memory/facts', id)).evidence as unknown[]).length, 1);

  // A bad evidence path still fails fast, before any anchor check.
  await assert.rejects(
    () => runCli(['verify', id, '--cwd', target, '--evidence-file', join(target, 'nope.txt')]),
    rejectsWith(/evidence file not found/),
  );
});

test('#39: remember validates every input before copying evidence, so a later refusal leaves no orphan copy', async () => {
  const target = await initProject();
  const good = join(target, 'good.txt');
  await writeFile(good, 'good evidence');
  const t = await addFact(target, 'Edge target');

  const attempts: string[][] = [
    ['--evidence', good, '--evidence', join(target, 'missing.txt')],
    ['--evidence', good, '--valid-from', 'garbage'],
    ['--evidence', good, '--conflicts-with', 'ms_MISSING'],
    ['--evidence', good, '--derived-from', 'ms_MISSING'],
    ['--evidence', good, '--answers-question', 'ms_MISSING'],
    ['--evidence', good, '--conflicts-with', t, '--refines', t],
  ];
  for (const extra of attempts) {
    await assert.rejects(() => runCli(['remember', 'fact', 'Orphaning attempt', '--cwd', target, '--source', 'test', '--body', 'B', ...extra]));
    assert.deepEqual(await evidenceFiles(target), [], `orphan left by ${extra.join(' ')}`);
  }

  const ok = await runCli(['remember', 'fact', 'Orphaning attempt', '--cwd', target, '--source', 'test', '--body', 'B', '--evidence', good]);
  assert.match(ok.stdout, /Evidence \(1\)/);
  assert.equal((await evidenceFiles(target)).length, 1);
});

test('#41: remember validates positive-edge targets (derived_from / refines / supports / depends_on) exist', async () => {
  const target = await initProject();
  const t = await addFact(target, 'Premise');
  const before = (await factIds(target)).length;
  for (const flag of ['--derived-from', '--refines', '--supports', '--depends-on']) {
    await assert.rejects(
      () => runCli(['remember', 'fact', 'Dangling edge', '--cwd', target, '--source', 'test', '--body', 'B', flag, 'ms_TYPO']),
      rejectsWith(new RegExp(`${flag} target not found: ms_TYPO`)),
    );
  }
  assert.equal((await factIds(target)).length, before);
  const ok = await runCli(['remember', 'fact', 'Dangling edge', '--cwd', target, '--source', 'test', '--body', 'B', '--derived-from', t]);
  assert.match(ok.stdout, new RegExp(`Derived from: ${t}`));
});

test('#42: supersede --body carries requires_human and evidence to the replacement', async () => {
  const target = await initProject();
  const proof = join(target, 'runbook-proof.txt');
  await writeFile(proof, 'ran it');
  await runCli([
    'remember', 'procedure', 'Prod rollout', '--cwd', target, '--source', 'test', '--body', 'v1',
    '--requires-human', 'approve prod', '--requires-human', 'rotate key', '--evidence', proof, '--evidence', 'https://example.com/run',
  ]);
  const procDir = join(target, '.memspec', 'memory', 'procedures');
  const oldId = (await readdir(procDir))[0].replace(/\.md$/, '');

  const out = await runCli(['supersede', oldId, '--cwd', target, '--reason', 'revised', '--body', 'v2']);
  assert.match(out.stdout, /Carried to ms_[0-9A-Z]+: requires_human \(2 step\(s\)\), evidence \(2 entries\)/);
  const newId = (await readdir(procDir)).map((f) => f.replace(/\.md$/, '')).find((id) => id !== oldId)!;
  const fm = await frontmatter(target, 'memory/procedures', newId);
  assert.deepEqual(fm.requires_human, ['approve prod', 'rotate key']);
  assert.equal((fm.evidence as unknown[]).length, 2);
  assert.equal(fm.supersede_reason, 'revised');
});

test('#11: --store <layer> is honoured for config.yaml-declared layers (unknown name errors, read-only layer refuses by name)', async () => {
  const base = await makeTempProject();
  const home = join(base, 'home');
  const team = join(base, 'team');
  await runCli(['init', '--cwd', home]);
  await runCli(['init', '--cwd', team]);
  await writeFile(join(home, '.memspec', 'config.yaml'), [
    'stores:',
    '  - name: personal', '    path: ~/.memspec', '    priority: 10', '    writable: true',
    '  - name: team', `    path: ${join(team, '.memspec')}`, '    priority: 0', '    writable: false',
    '',
  ].join('\n'));
  const env = { HOME: home };

  await assert.rejects(
    () => runCli(['remember', 'fact', 'Team thing', '--cwd', home, '--source', 'test', '--store', 'team'], undefined, env),
    rejectsWith(/layer 'team' is not writable \(writable: false/),
  );
  await assert.rejects(
    () => runCli(['remember', 'fact', 'Bogus thing', '--cwd', home, '--source', 'test', '--store', 'bogus'], undefined, env),
    rejectsWith(/no layer named 'bogus' in .*config\.yaml \(have: personal, team( \(read-only\))?\)/),
  );
  assert.equal(existsSync(join(home, '.memspec', 'memory', 'facts')) ? (await readdir(join(home, '.memspec', 'memory', 'facts'))).length : 0, 0, 'nothing landed in the personal store');
  assert.equal((await readdir(join(team, '.memspec', 'memory', 'facts'))).length, 0, 'nothing landed in the read-only team store');

  // Naming the writable layer lands there.
  const ok = await runCli(['remember', 'fact', 'Personal thing', '--cwd', home, '--source', 'test', '--store', 'personal'], undefined, env);
  assert.match(ok.stdout, /Created fact memory/);
  assert.equal((await readdir(join(home, '.memspec', 'memory', 'facts'))).length, 1);

  // The legacy `--store global` spelling still reaches ~/.memspec when no layer is named global.
  const legacy = await runCli(['remember', 'fact', 'Legacy global', '--cwd', team, '--source', 'test', '--store', 'global'], undefined, env);
  assert.match(legacy.stdout, /Created fact memory/);
  assert.equal((await readdir(join(home, '.memspec', 'memory', 'facts'))).length, 2);

  // An unknown --store on a store with no layers at all is an error, not a silent write.
  await assert.rejects(
    () => runCli(['remember', 'fact', 'Nowhere', '--cwd', team, '--source', 'test', '--store', 'nowhere'], undefined, env),
    rejectsWith(/no layer named 'nowhere' in .*\(no stores: block\)/),
  );
});

test('#29: relate and unrelate refuse a question record as --from', async () => {
  const target = await initProject();
  const a = await addFact(target, 'Q answer');
  const other = await addFact(target, 'Unrelated claim');
  await runCli(['question', 'Edges on me?', '--cwd', target, '--source', 'test', '--answers', a]);
  const qid = (await readdir(join(target, '.memspec', 'memory', 'questions')))[0].replace(/\.md$/, '');

  await assert.rejects(
    () => runCli(['relate', '--cwd', target, '--from', qid, '--to', other, '--type', 'refines']),
    rejectsWith(/relate refuses a question record as --from/),
  );
  await assert.rejects(
    () => runCli(['unrelate', '--cwd', target, '--from', qid, '--to', other, '--type', 'refines', '--reason', 'r']),
    rejectsWith(/unrelate refuses a question record as --from/),
  );
  assert.equal((await frontmatter(target, 'memory/questions', qid)).refines, undefined);
  // A claim → question edge is still the claim's business.
  const ok = await runCli(['relate', '--cwd', target, '--from', other, '--to', qid, '--type', 'depends_on']);
  assert.match(ok.stdout, /Linked/);
});

test('#34: MCP tool descriptions name derived_from and the v0.11 status sections', async () => {
  const target = await initProject();
  const session = new McpSession([join(REPO_ROOT, 'src/mcp.ts'), '--cwd', target]);
  try {
    await initSession(session);
    const list = await session.request('tools/list');
    const tools = (list.result as { tools: Array<{ name: string; description?: string; inputSchema?: { properties?: Record<string, { description?: string; items?: { enum?: string[] } }> } }> }).tools;
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of ['memspec_relate', 'memspec_unrelate']) {
      const tool = byName.get(name)!;
      assert.ok(tool.description?.includes('derived_from'), `${name} description`);
      assert.ok(tool.inputSchema?.properties?.type?.description?.includes('derived_from'), `${name} type param`);
    }
    const search = byName.get('memspec_search')!;
    assert.ok(search.description?.includes('derived_from / conflicts_with'), 'search expand_edges list');
    assert.ok(search.inputSchema?.properties?.edge_types?.description?.includes('all seven'), 'edge_types default text');
    const status = byName.get('memspec_status')!;
    for (const word of ['cold', 'promotion_candidates', 'questions', 'evidence_backed']) {
      assert.ok(status.description?.includes(word), `status description mentions ${word}`);
    }
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
