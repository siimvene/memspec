import test from 'node:test';
import assert from 'node:assert/strict';
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
        { sha256: 'd'.repeat(64), name: 'notes.txt', path: `evidence/${'d'.repeat(12)}/notes.txt`, source: 'repo:notes.txt', captured_at: '2026-05-03T01:00:00.000Z' },
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
  const files = (await readdir(out)).sort();
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
