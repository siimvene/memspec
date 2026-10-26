import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExportOkf } from '../src/commands/export.js';
import { runImportOkf } from '../src/commands/import-okf.js';
import { validateOkfConcept, OKF_VERSION } from '../src/commands/okf.js';
import { parseFrontMatter } from '../src/lib/safe-matter.js';
import { MemspecStore } from '../src/lib/store.js';
import type { MemoryFrontmatter } from '../src/lib/types.js';
import { runCli } from './helpers.js';

const ID = (n: number): string => `ms_${String(n).padStart(26, '0').replace(/0/g, 'A').slice(0, 26)}`;
const FUTURE = '2099-01-01T00:00:00.000Z';
const BLOB = Buffer.from('evidence notes\n');
const BLOB_SHA = createHash('sha256').update(BLOB).digest('hex');
const BLOB_PATH = `evidence/${BLOB_SHA.slice(0, 12)}/notes.txt`;

type Rec = MemoryFrontmatter & { title: string; body: string };

function base(n: number, extra: Partial<Rec>): Rec {
  return {
    id: ID(n),
    kind: 'claim',
    type: 'fact',
    state: 'active',
    created: '2026-03-01T10:00:00.000Z',
    source: 'agent-x',
    source_kind: 'agent',
    tags: [],
    check_by: FUTURE,
    title: `Record ${n}`,
    body: `# Record ${n}\n\nBody text for record ${n}.\n\n- bullet: with colon\n- "quoted" line`,
    ...extra,
  } as Rec;
}

/** Every type, state, edge kind, anchor, evidence shape and temporal-validity field. */
function fixture(): Rec[] {
  return [
    base(1, {
      type: 'fact', tags: ['alpha', 'beta'], scope: 'universal', pinned: true, source: 'siim', source_kind: 'operator',
      verified_with: 'anchor', last_verified: '2026-04-01T08:00:00.000Z',
      anchors: [{ file: 'src/a.ts', sha: 'a'.repeat(40) }, { file: 'lib/b.ts', sha: 'b'.repeat(40), repo: 'other-repo' }],
      valid_from: '2026-01-01T00:00:00Z', valid_to: '2027-01-01T00:00:00Z',
      refines: [ID(2)], supports: [ID(3), ID(4)], depends_on: [ID(5)], derived_from: [ID(6)],
      conflicts_with: [ID(7)], distinct_from: [ID(8)],
      ext: { confirmations: 2, edge_sources: { [ID(7)]: 'asserted' }, nested: { list: [1, 'two', { three: 3 }] } },
    }),
    base(2, { type: 'decision', check_by: 'never', verified_with: 'operator', last_verified: '2026-05-01T00:00:00.000Z', source: 'siim', source_kind: 'operator' }),
    base(3, {
      type: 'procedure', requires_human: ['approve the deploy'], verified_with: 'probe', last_verified: '2026-05-02T00:00:00.000Z',
      probe: { cmd: 'echo hi', hash: 'c'.repeat(64) },
    }),
    base(4, {
      verified_with: 'evidence', last_verified: '2026-05-03T00:00:00.000Z',
      evidence: [
        { url: 'https://example.com/doc', captured_at: '2026-05-03T00:00:00.000Z' },
        { sha256: BLOB_SHA, name: 'notes.txt', path: BLOB_PATH, source: 'repo:notes.txt', captured_at: '2026-05-03T01:00:00.000Z' },
      ],
    }),
    base(5, { verified_with: 'assertion', last_verified: '2026-03-02T00:00:00.000Z', source: 'imp', source_kind: 'import' }),
    base(6, {}),
    // stale by check_by in the past, never verified
    base(7, { check_by: '2026-03-15T00:00:00.000Z' }),
    base(8, { state: 'superseded', superseded_by: ID(9), supersede_reason: 'replaced: new "approach"', check_by: FUTURE }),
    base(9, { supersedes: [ID(8), ID(10)] }),
    base(10, { state: 'retired', type: 'decision' }),
    {
      id: ID(11), kind: 'observation', state: 'active', created: '2026-06-01T00:00:00.000Z', source: 'agent-x',
      source_kind: 'agent', tags: ['obs'], check_by: '2026-06-08T00:00:00.000Z', expires: '2026-06-08T00:00:00.000Z',
      title: 'Observation 11', body: '# Observation 11\n\nSaw a thing.',
    } as Rec,
    {
      id: ID(12), kind: 'question', state: 'open', created: '2026-06-02T00:00:00.000Z', source: 'agent-x', source_kind: 'agent',
      tags: [], check_by: FUTURE, answers: [ID(1), ID(2)], closed: true, title: 'Question 12', body: '# Question 12\n\nWhich one?',
    } as Rec,
    {
      id: ID(13), kind: 'question', state: 'resolved', created: '2026-06-03T00:00:00.000Z', source: 'agent-x', source_kind: 'agent',
      tags: [], check_by: FUTURE, answers: [ID(1)], closed: false, resolved_by: ID(1), title: 'Question 13', body: '# Question 13\n\nSettled.',
    } as Rec,
  ];
}

async function makeStore(records: Rec[]): Promise<{ dir: string; store: MemspecStore }> {
  const dir = await mkdtemp(join(tmpdir(), 'memspec-okf-'));
  const store = new MemspecStore(dir);
  store.init();
  for (const r of records) store.writeItem(r);
  if (records.some((r) => r.evidence?.some((e) => e.path === BLOB_PATH))) {
    mkdirSync(join(store.root, BLOB_PATH, '..'), { recursive: true });
    writeFileSync(join(store.root, BLOB_PATH), BLOB);
  }
  return { dir, store };
}

/** Normalised view of a store: frontmatter + body per id, derived/volatile fields dropped. */
function snapshot(store: MemspecStore): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const item of store.loadAll()) {
    const { filePath: _f, stale: _s, ...rest } = item;
    out[item.id] = JSON.parse(JSON.stringify(rest));
  }
  return out;
}

async function bundle(dir: string): Promise<string> {
  return mkdtemp(join(tmpdir(), 'memspec-okf-out-')).then((p) => join(p, 'bundle')).then((p) => {
    runExportOkf({ cwd: dir, out: p });
    return p;
  });
}

test('round trip memspec -> OKF -> memspec is lossless for every field', async () => {
  const { dir, store } = await makeStore(fixture());
  const out = await bundle(dir);

  const target = await mkdtemp(join(tmpdir(), 'memspec-okf-in-'));
  const res = runImportOkf({ cwd: target, dir: out });
  assert.deepEqual(res.errors, []);
  assert.deepEqual(res.skipped, []);
  assert.equal(res.imported.length, 13);

  const before = snapshot(store);
  const after = snapshot(new MemspecStore(target));
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
  for (const id of Object.keys(before)) assert.deepEqual(after[id], before[id], `record ${id}`);
});

test('fixture exercises every frontmatter field named in SCHEMA.md', async () => {
  const schema = await readFile(join(import.meta.dirname, '..', 'SCHEMA.md'), 'utf8');
  const fields = [...schema.matchAll(/^### `([a-z_]+)`$/gm)].map((m) => m[1]);
  const used = new Set<string>();
  for (const r of fixture()) for (const [k, v] of Object.entries(r)) if (v !== undefined) used.add(k);
  // `stale` is derived from check_by at read time and deliberately not exported.
  const missing = fields.filter((f) => !used.has(f) && f !== 'stale');
  assert.deepEqual(missing, [], `fixture lacks: ${missing.join(', ')}`);
});

test('stale is not exported but is re-derived from check_by on the imported store', async () => {
  const { dir } = await makeStore(fixture());
  const out = await bundle(dir);
  const raw = parseFrontMatter(await readFile(join(out, `${ID(7)}.md`), 'utf8')).data;
  assert.equal((raw['x-memspec'] as Record<string, unknown>).stale, undefined);
  const target = await mkdtemp(join(tmpdir(), 'memspec-okf-in-'));
  runImportOkf({ cwd: target, dir: out });
  const item = new MemspecStore(target).loadAll().find((i) => i.id === ID(7));
  assert.equal(item?.stale, true);
});

test('OKF output meets the spec required fields and the shapes of the emitted families', async () => {
  const { dir } = await makeStore(fixture());
  const out = await bundle(dir);
  const entries = (await readdir(out)).sort();
  assert.ok(entries.includes('evidence'), 'evidence blobs travel in the bundle');
  const files = entries.filter((f) => f.endsWith('.md'));
  assert.ok(files.includes('index.md'));
  assert.ok(!files.includes('log.md'));
  assert.equal(files.filter((f) => f !== 'index.md').length, 13);

  for (const f of files) {
    const parsed = parseFrontMatter(await readFile(join(out, f), 'utf8'));
    if (f === 'index.md') {
      // §8: no frontmatter except okf_version at the bundle root.
      assert.deepEqual(parsed.data, { okf_version: OKF_VERSION });
      assert.match(parsed.content, /^# Facts$/m);
      continue;
    }
    assert.deepEqual(validateOkfConcept(parsed.data), [], f);
  }

  // Spot-check the mapping on the richest record.
  const one = parseFrontMatter(await readFile(join(out, `${ID(1)}.md`), 'utf8'));
  const d = one.data as Record<string, any>;
  assert.equal(d.type, 'Fact');
  assert.equal(d.status, 'stable');
  assert.equal(d.stale_after, FUTURE);
  assert.deepEqual(d.generated, { by: 'human:siim', at: '2026-03-01T10:00:00.000Z' });
  assert.deepEqual(d.verified, [{ by: 'process:anchor', at: '2026-04-01T08:00:00.000Z' }]);
  assert.equal(d.sources.length, 2);
  assert.equal(d.sources[1].resource, 'other-repo:lib/b.ts');
  assert.match(one.content, new RegExp(`\\* \\[Record 2\\]\\(/${ID(2)}\\.md\\) - refines`));
  assert.ok((d['x-memspec'].edges as unknown[]).length >= 7);

  // Lifecycle and trust mapping.
  const sup = parseFrontMatter(await readFile(join(out, `${ID(8)}.md`), 'utf8')).data as Record<string, any>;
  assert.equal(sup.status, 'deprecated');
  const never = parseFrontMatter(await readFile(join(out, `${ID(2)}.md`), 'utf8')).data as Record<string, any>;
  assert.equal(never.stale_after, undefined);
  assert.deepEqual(never.verified, [{ by: 'human:operator', at: '2026-05-01T00:00:00.000Z' }]);
  const assertion = parseFrontMatter(await readFile(join(out, `${ID(5)}.md`), 'utf8')).data as Record<string, any>;
  assert.equal(assertion.verified, undefined, 'an assertion is not a verification');
  const q = parseFrontMatter(await readFile(join(out, `${ID(12)}.md`), 'utf8')).data as Record<string, any>;
  assert.equal(q.type, 'Question');
  assert.equal(q.status, 'draft');
});

test('import rejects an invalid record, skips foreign and existing files, and keeps going', async () => {
  const { dir } = await makeStore(fixture());
  const out = await bundle(dir);

  // Corrupt one record (state outside the enum), add a foreign OKF concept and a reserved file.
  const bad = join(out, `${ID(6)}.md`);
  await writeFile(bad, (await readFile(bad, 'utf8')).replace('x-memspec:\n', 'x-memspec:\n  state: bogus\n'));
  await writeFile(join(out, 'foreign.md'), '---\ntype: Reference\ntitle: Foreign\n---\n\nHello\n');
  await writeFile(join(out, 'log.md'), '# Directory Update Log\n');

  const target = await mkdtemp(join(tmpdir(), 'memspec-okf-in-'));
  const res = runImportOkf({ cwd: target, dir: out });
  assert.equal(res.errors.length, 1);
  assert.match(res.errors[0].file, new RegExp(ID(6)));
  assert.equal(res.skipped.length, 1);
  assert.match(res.skipped[0].file, /foreign\.md$/);
  assert.equal(res.imported.length, 12);

  // Re-import: everything that landed is skipped, never overwritten.
  const again = runImportOkf({ cwd: target, dir: out });
  assert.equal(again.imported.length, 0);
  assert.equal(again.skipped.filter((s) => /already exists/.test(s.reason)).length, 12);
});

test('export refuses a non-empty output directory', async () => {
  const { dir } = await makeStore(fixture());
  const out = await bundle(dir);
  assert.throws(() => runExportOkf({ cwd: dir, out }), /not empty/);
});

test('a body that contains the reserved links marker is skipped, not corrupted', async () => {
  const { dir } = await makeStore([base(1, { body: '# Record 1\n\n<!-- memspec:links -->\nhi' }), base(2, {})]);
  const out = join(await mkdtemp(join(tmpdir(), 'memspec-okf-out-')), 'b');
  const res = runExportOkf({ cwd: dir, out });
  assert.equal(res.written, 1);
  assert.equal(res.skipped.length, 1);
  assert.equal(res.skipped[0].id, ID(1));
});

test('CLI: export --format okf --out then import --format okf round-trips', async () => {
  const { dir, store } = await makeStore(fixture());
  const out = join(await mkdtemp(join(tmpdir(), 'memspec-okf-out-')), 'cli');
  const exp = await runCli(['export', '--format', 'okf', '--out', out, '--cwd', dir]);
  assert.match(exp.stdout, /Wrote 13 OKF documents/);

  const target = await mkdtemp(join(tmpdir(), 'memspec-okf-in-'));
  const imp = await runCli(['import', '--format', 'okf', out, '--cwd', target]);
  assert.match(imp.stdout, /Imported 13 records \(0 skipped, 0 errors\)/);
  assert.deepEqual(snapshot(new MemspecStore(target)), snapshot(store));

  await assert.rejects(runCli(['export', '--format', 'okf', '--cwd', dir]), /requires --out/);
  await assert.rejects(runCli(['export', '--format', 'jsonl', '--out', out, '--cwd', dir]), /only applies to --format okf/);
});

// --- review findings (consort panel) ---------------------------------------

function layerDecl(entries: Array<{ name: string; path: string; priority: number; writable: boolean }>): string {
  return 'stores:\n' + entries.map((e) => `  - name: ${e.name}\n    path: ${e.path}\n    priority: ${e.priority}\n    writable: ${e.writable}\n`).join('');
}

test('file-backed evidence blobs travel in the bundle and back; a missing blob refuses the record', async () => {
  const { dir } = await makeStore(fixture());
  const out = await bundle(dir);
  assert.deepEqual(await readFile(join(out, BLOB_PATH)), BLOB);

  const target = await mkdtemp(join(tmpdir(), 'memspec-okf-in-'));
  const res = runImportOkf({ cwd: target, dir: out });
  assert.deepEqual(res.errors, []);
  assert.deepEqual(await readFile(join(target, '.memspec', BLOB_PATH)), BLOB);

  // Same bundle without the blob: the evidence-witnessed record is refused, the rest import.
  rmSync(join(out, 'evidence'), { recursive: true });
  const bare = await mkdtemp(join(tmpdir(), 'memspec-okf-in-'));
  const res2 = runImportOkf({ cwd: bare, dir: out });
  assert.equal(res2.errors.length, 1);
  assert.match(res2.errors[0].file, new RegExp(ID(4)));
  assert.match(res2.errors[0].reason, /evidence blob .* is missing/);
  assert.equal(res2.imported.length, 12);

  // A source store whose blob is already gone: exported, but reported.
  const { dir: src, store } = await makeStore(fixture());
  rmSync(join(store.root, 'evidence'), { recursive: true });
  const exp = runExportOkf({ cwd: src, out: join(await mkdtemp(join(tmpdir(), 'memspec-okf-out-')), 'b') });
  assert.equal(exp.written, 13);
  assert.deepEqual(exp.missingEvidence.map((m) => m.id), [ID(4)]);
});

test('import places questions under memory/questions and superseded/retired records under archive', async () => {
  const { dir } = await makeStore(fixture());
  const out = await bundle(dir);
  const target = await mkdtemp(join(tmpdir(), 'memspec-okf-in-'));
  runImportOkf({ cwd: target, dir: out });
  const root = join(target, '.memspec');
  for (const id of [ID(12), ID(13)]) assert.ok(existsSync(join(root, 'memory', 'questions', `${id}.md`)), `question ${id}`);
  for (const id of [ID(8), ID(10)]) assert.ok(existsSync(join(root, 'archive', `${id}.md`)), `archived ${id}`);
  const active = new MemspecStore(target).activeSourceFiles().map((f) => f.split('/').pop());
  for (const id of [ID(8), ID(10)]) assert.ok(!active.includes(`${id}.md`), `${id} is not an active source file`);
  assert.ok(!existsSync(join(root, 'observations', `${ID(12)}.md`)));
});

test('export and import resolve the layered store like search and remember do', async () => {
  const { dir: layerDir, store } = await makeStore(fixture());
  // A repo with only a pointer file: export reads the declared layer.
  const repo = await mkdtemp(join(tmpdir(), 'memspec-okf-repo-'));
  await writeFile(join(repo, '.memspec.yaml'), layerDecl([{ name: 'team', path: store.root, priority: 10, writable: true }]));
  const out = join(await mkdtemp(join(tmpdir(), 'memspec-okf-out-')), 'b');
  assert.equal(runExportOkf({ cwd: repo, out }).written, 13);
  assert.ok(!existsSync(join(repo, '.memspec')));

  // Import through a pointer lands in the pointer's layer, not a phantom <repo>/.memspec.
  const dest = await mkdtemp(join(tmpdir(), 'memspec-okf-dest-'));
  const repo2 = await mkdtemp(join(tmpdir(), 'memspec-okf-repo-'));
  await writeFile(join(repo2, '.memspec.yaml'), layerDecl([{ name: 'team', path: join(dest, '.memspec'), priority: 10, writable: true }]));
  mkdirSync(join(dest, '.memspec'));
  assert.equal(runImportOkf({ cwd: repo2, dir: out }).imported.length, 13);
  assert.ok(!existsSync(join(repo2, '.memspec')));
  assert.equal(new MemspecStore(join(dest, '.memspec')).loadAll().length, 13);

  // Only read-only layers: import refuses and writes nothing.
  const repo3 = await mkdtemp(join(tmpdir(), 'memspec-okf-repo-'));
  await writeFile(join(repo3, '.memspec.yaml'), layerDecl([{ name: 'team', path: join(layerDir, '.memspec'), priority: 10, writable: false }]));
  const before = new MemspecStore(join(layerDir, '.memspec')).recordFiles().length;
  assert.throws(() => runImportOkf({ cwd: repo3, dir: out }), /no writable store layer/);
  assert.equal(new MemspecStore(join(layerDir, '.memspec')).recordFiles().length, before);
  assert.ok(!existsSync(join(repo3, '.memspec')));
});

test('export reports records that fail to load and the CLI exits non-zero', async () => {
  const { dir, store } = await makeStore([base(1, {}), base(2, {})]);
  await writeFile(join(store.root, 'memory', 'facts', 'ms_BROKEN.md'), '---\nid: ms_BROKEN\nkind: claim\n---\n# Broken\n');
  const out = join(await mkdtemp(join(tmpdir(), 'memspec-okf-out-')), 'b');
  const res = runExportOkf({ cwd: dir, out });
  assert.equal(res.written, 2);
  assert.equal(res.unreadable.length, 1);
  assert.match(res.unreadable[0].file, /ms_BROKEN\.md$/);

  const out2 = join(await mkdtemp(join(tmpdir(), 'memspec-okf-out-')), 'b');
  await assert.rejects(runCli(['export', '--format', 'okf', '--out', out2, '--cwd', dir]), (err: { code?: number; stderr?: string }) => {
    assert.equal(err.code, 1);
    assert.match(String(err.stderr), /unreadable .*ms_BROKEN\.md/);
    return true;
  });
});

test('import never overwrites an existing record file, even one that fails to load', async () => {
  const { dir } = await makeStore([base(1, {})]);
  const out = await bundle(dir);
  const target = await mkdtemp(join(tmpdir(), 'memspec-okf-in-'));
  const targetStore = new MemspecStore(target);
  targetStore.init();
  const corrupt = join(targetStore.root, 'memory', 'facts', `${ID(1)}.md`);
  writeFileSync(corrupt, '---\nid: broken\n---\nhand-edited, invalid\n');
  const res = runImportOkf({ cwd: target, dir: out });
  assert.equal(res.imported.length, 0);
  assert.match(res.skipped[0].reason, /already exists/);
  assert.equal(await readFile(corrupt, 'utf8'), '---\nid: broken\n---\nhand-edited, invalid\n');
});

test('import refuses edited native type/status instead of reading them as the default', async () => {
  const { dir } = await makeStore(fixture());
  const out = await bundle(dir);
  const retired = join(out, `${ID(10)}.md`);
  await writeFile(retired, (await readFile(retired, 'utf8')).replace('status: deprecated', 'status: bogus'));
  const typed = join(out, `${ID(6)}.md`);
  await writeFile(typed, (await readFile(typed, 'utf8')).replace('type: Fact', 'type: Bogus'));
  const target = await mkdtemp(join(tmpdir(), 'memspec-okf-in-'));
  const res = runImportOkf({ cwd: target, dir: out });
  assert.deepEqual(res.errors.map((e) => e.file.split('/').pop()).sort(), [`${ID(10)}.md`, `${ID(6)}.md`].sort());
  assert.match(res.errors.find((e) => e.file.endsWith(`${ID(10)}.md`))!.reason, /invalid status bogus/);
  assert.equal(new MemspecStore(target).findById(ID(10)), null);
});

test('import skips files whose front matter is empty or not a mapping as foreign', async () => {
  const { dir } = await makeStore([base(1, {})]);
  const out = await bundle(dir);
  await writeFile(join(out, 'empty.md'), '---\n# only a comment\n---\nhello\n');
  await writeFile(join(out, 'scalar.md'), '---\njust a string\n---\nhello\n');
  const res = runImportOkf({ cwd: await mkdtemp(join(tmpdir(), 'memspec-okf-in-')), dir: out });
  assert.deepEqual(res.errors, []);
  assert.equal(res.imported.length, 1);
  for (const f of ['empty.md', 'scalar.md']) {
    assert.match(res.skipped.find((s) => s.file.endsWith(f))!.reason, /no x-memspec extension/);
  }
});

test('import accepts unquoted YAML timestamps in the extension and native fields', async () => {
  const { dir } = await makeStore([base(1, { valid_from: '2026-01-01T00:00:00.000Z' })]);
  const out = await bundle(dir);
  const f = join(out, `${ID(1)}.md`);
  const raw = await readFile(f, 'utf8');
  const unquoted = raw.replace(/'(\d{4}-\d{2}-\d{2}T[\d:.]+Z)'/g, '$1');
  assert.notEqual(unquoted, raw, 'fixture has quoted timestamps to unquote');
  await writeFile(f, unquoted);
  const target = await mkdtemp(join(tmpdir(), 'memspec-okf-in-'));
  const res = runImportOkf({ cwd: target, dir: out });
  assert.deepEqual(res.errors, []);
  const item = new MemspecStore(target).findById(ID(1))!;
  assert.equal(item.valid_from, '2026-01-01T00:00:00.000Z');
  assert.equal(item.check_by, FUTURE);
});

test('record titles and descriptions cannot inject links into generated navigation', async () => {
  const evil = 'Legit](https://attacker.example)[x <a href="https://attacker.example">y</a>';
  const { dir } = await makeStore([
    base(1, { title: evil, body: `# ${evil}\n\n[click](https://attacker.example)` }),
    base(2, { refines: [ID(1)] }),
  ]);
  const out = await bundle(dir);
  const index = await readFile(join(out, 'index.md'), 'utf8');
  const links = (await readFile(join(out, `${ID(2)}.md`), 'utf8'));
  for (const text of [index, links]) {
    assert.ok(!/\]\(https:\/\/attacker/.test(text.replace(/\\\]/g, '')), 'no live link to the attacker');
    assert.ok(!/<a href/.test(text.replace(/\\</g, '')), 'no live inline HTML');
  }
  // The record's own body still round-trips verbatim.
  const target = await mkdtemp(join(tmpdir(), 'memspec-okf-in-'));
  runImportOkf({ cwd: target, dir: out });
  assert.equal(new MemspecStore(target).findById(ID(1))!.title, evil);
});

test('a source already in actor form is exported as that actor', async () => {
  const { dir } = await makeStore([base(1, { source: 'human:siim', source_kind: 'operator' })]);
  const out = await bundle(dir);
  const d = parseFrontMatter(await readFile(join(out, `${ID(1)}.md`), 'utf8')).data as Record<string, any>;
  assert.equal(d.generated.by, 'human:siim');
});

test('concurrent exports to one --out: exactly one wins, the bundle is not mixed', async () => {
  const { dir: a } = await makeStore([base(1, {}), base(2, {})]);
  const { dir: b } = await makeStore([base(3, {}), base(4, {}), base(5, {})]);
  const parent = await mkdtemp(join(tmpdir(), 'memspec-okf-out-'));
  const out = join(parent, 'b');
  const settled = await Promise.allSettled([
    runCli(['export', '--format', 'okf', '--out', out, '--cwd', a]),
    runCli(['export', '--format', 'okf', '--out', out, '--cwd', b]),
  ]);
  assert.equal(settled.filter((s) => s.status === 'fulfilled').length, 1);
  const files = (await readdir(out)).filter((f) => f !== 'index.md').sort();
  const ok = [[ID(1), ID(2)], [ID(3), ID(4), ID(5)]].map((ids) => ids.map((i) => `${i}.md`));
  assert.ok(ok.some((want) => JSON.stringify(want) === JSON.stringify(files)), `mixed bundle: ${files.join(',')}`);
  assert.deepEqual((await readdir(parent)).sort(), ['b'], 'no staging directory left behind');
});
