import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateFrontmatter } from '../src/lib/schema.js';
import { parseMemoryFile, serializeMemoryFile } from '../src/lib/frontmatter.js';
import { EDGE_TYPES, expandGraph, isDerived } from '../src/lib/graph-walk.js';
import { buildLineage } from '../src/lib/lineage.js';
import { attachEvidence, describeEvidenceSource, isFileBackedEvidence, MAX_EVIDENCE_BYTES, validateEvidenceSource } from '../src/lib/evidence.js';
import { createQuestion, addAnswers, eliminationStatus, resolveQuestion, setClosed, assertAnswerCandidate, QUESTIONS_SUBDIR } from '../src/lib/questions.js';
import { MemspecStore } from '../src/lib/store.js';
import type { MemoryFrontmatter, MemoryItem } from '../src/lib/types.js';

const ID = 'ms_01HXK7Y3P5QZJKM8N4R2T6W9VB';
const OTHER = 'ms_01HXK7Y3P5QZJKM8N4R2T6ABC0';

function base(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    id: ID,
    kind: 'claim',
    type: 'fact',
    state: 'active',
    created: '2026-04-04T10:30:00Z',
    source: 'test',
    tags: [],
    check_by: 'never',
    ...extra,
  };
}

async function freshStore(): Promise<{ store: MemspecStore; root: string }> {
  const target = await mkdtemp(join(tmpdir(), 'memspec-v11-'));
  const store = new MemspecStore(target);
  store.init();
  return { store, root: store.root };
}

function addClaim(store: MemspecStore, title: string, type: 'fact' | 'decision' | 'procedure' = 'fact'): MemoryItem {
  const id = `ms_${title.replace(/[^A-Z0-9]/gi, '').toUpperCase().padEnd(26, '0').slice(0, 26)}`;
  const record: MemoryFrontmatter & { title: string; body: string } = {
    id,
    kind: 'claim',
    type,
    state: 'active',
    created: new Date().toISOString(),
    source: 'test',
    tags: [],
    check_by: 'never',
    title,
    body: `# ${title}`,
  };
  store.writeItem(record);
  return store.findById(id)!;
}

// --- S1: requires_human actuation boundary ---

test('S1: requires_human is accepted on a procedure and round-trips', () => {
  const result = validateFrontmatter(base({ type: 'procedure', requires_human: ['approve in console', 'rotate key'] }));
  assert.equal(result.success, true);

  const serialized = serializeMemoryFile({
    ...base({ type: 'procedure', requires_human: ['approve in console'] }) as unknown as MemoryFrontmatter,
    title: 'Deploy',
    body: 'Body',
  });
  const parsed = parseMemoryFile(serialized, '/dev/null');
  assert.deepEqual(parsed.requires_human, ['approve in console']);
});

test('S1: requires_human is rejected on fact and decision', () => {
  for (const type of ['fact', 'decision'] as const) {
    const result = validateFrontmatter(base({ type, requires_human: ['nope'] }));
    assert.equal(result.success, false, `${type} must reject requires_human`);
  }
});

test('S1: a record without requires_human still validates (backward compatible)', () => {
  assert.equal(validateFrontmatter(base({ type: 'procedure' })).success, true);
});

// --- S2: derived_from edge ---

test('S2: derived_from is accepted, round-trips, and drives isDerived', () => {
  const result = validateFrontmatter(base({ derived_from: [OTHER] }));
  assert.equal(result.success, true);

  const serialized = serializeMemoryFile({
    ...base({ derived_from: [OTHER] }) as unknown as MemoryFrontmatter,
    title: 'Derived',
    body: 'Body',
  });
  const parsed = parseMemoryFile(serialized, '/dev/null');
  assert.deepEqual(parsed.derived_from, [OTHER]);
  assert.equal(isDerived(parsed), true);
  assert.equal(isDerived({ derived_from: [] }), false);
  assert.equal(isDerived({}), false);
});

test('S2: derived_from rejects non-array and non-string elements', () => {
  assert.equal(validateFrontmatter(base({ derived_from: OTHER })).success, false);
  assert.equal(validateFrontmatter(base({ derived_from: [123] })).success, false);
});

test('S2: empty derived_from is omitted by the writer', () => {
  const serialized = serializeMemoryFile({
    ...base({ derived_from: [] }) as unknown as MemoryFrontmatter,
    title: 'X',
    body: 'B',
  });
  assert.equal(/^derived_from:/m.test(serialized), false);
});

test('S2: derived_from is a walkable edge type and expandGraph follows it', () => {
  assert.ok((EDGE_TYPES as readonly string[]).includes('derived_from'));
  const records = new Map<string, MemoryFrontmatter>([
    [ID, base({ derived_from: [OTHER] }) as unknown as MemoryFrontmatter],
    [OTHER, base({ id: OTHER }) as unknown as MemoryFrontmatter],
  ]);
  const hits = expandGraph([ID], records, { edgeTypes: ['derived_from'], maxDepth: 1 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, OTHER);
  assert.equal(hits[0].edge_type, 'derived_from');
});

test('S2: lineage exposes derived_from_chain', async () => {
  const { store } = await freshStore();
  const a = addClaim(store, 'AncestorD');
  const bRec: MemoryFrontmatter & { title: string; body: string } = {
    id: 'ms_0DERIVEDCHILD0000000000000',
    kind: 'claim', type: 'fact', state: 'active', created: new Date().toISOString(),
    source: 'test', tags: [], check_by: 'never', derived_from: [a.id], title: 'ChildD', body: '# ChildD',
  };
  store.writeItem(bRec);
  const all = store.loadAll();
  const seed = all.find((i) => i.id === bRec.id)!;
  const lineage = buildLineage(seed, all);
  assert.deepEqual(lineage.derived_from_chain.map((e) => e.id), [a.id]);
});

// --- S3: evidence attachments ---

test('S3: attachEvidence copies a local file content-addressed and returns a file-backed entry', async () => {
  const { store, root } = await freshStore();
  const src = join(await mkdtemp(join(tmpdir(), 'memspec-ev-')), 'proof.txt');
  await writeFile(src, 'evidence body');
  const entry = attachEvidence(root, src);
  assert.ok(entry.sha256 && entry.sha256.length === 64);
  assert.equal(entry.name, 'proof.txt');
  assert.equal(entry.path, `evidence/${entry.sha256!.slice(0, 12)}/proof.txt`);
  // #30: never the absolute path — a tmpdir file is neither under $HOME nor in a repo, so no source at all.
  assert.equal(entry.source, undefined);
  assert.ok(entry.captured_at);
  assert.ok(existsSync(join(root, entry.path!)));
  assert.equal(isFileBackedEvidence(entry), true);
  // Idempotent: same content reuses the same dir.
  const again = attachEvidence(root, src);
  assert.equal(again.path, entry.path);
});

test('S3: an http(s) URL is recorded as a pointer, never fetched', async () => {
  const { root } = await freshStore();
  const entry = attachEvidence(root, 'https://example.com/report.pdf');
  assert.equal(entry.url, 'https://example.com/report.pdf');
  assert.equal(entry.sha256, undefined);
  assert.equal(isFileBackedEvidence(entry), false);
  assert.ok(!existsSync(join(root, 'evidence')));
});

test('S3: a file over the 5 MB limit is refused', async () => {
  const { root } = await freshStore();
  const src = join(await mkdtemp(join(tmpdir(), 'memspec-big-')), 'big.bin');
  await writeFile(src, Buffer.alloc(MAX_EVIDENCE_BYTES + 1));
  assert.throws(() => attachEvidence(root, src), /too large/);
});

test('S3: a source under the store local/ subtree is refused', async () => {
  const { root } = await freshStore();
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(root, 'local'), { recursive: true });
  const localFile = join(root, 'local', 'secret.txt');
  await writeFile(localFile, 'secret');
  assert.throws(() => attachEvidence(root, localFile), /local\//);
});

test('S3: a file-backed evidence entry validates in frontmatter and round-trips', () => {
  const entry = { sha256: 'a'.repeat(64), name: 'x.txt', path: 'evidence/aaaaaaaaaaaa/x.txt', source: '/tmp/x.txt', captured_at: '2026-04-04T10:30:00Z' };
  const result = validateFrontmatter(base({ evidence: [entry] }));
  assert.equal(result.success, true);
  const serialized = serializeMemoryFile({
    ...base({ evidence: [entry, { url: 'https://e.com', captured_at: '2026-04-04T10:30:00Z' }] }) as unknown as MemoryFrontmatter,
    title: 'E', body: 'B',
  });
  const parsed = parseMemoryFile(serialized, '/dev/null');
  assert.equal(parsed.evidence?.length, 2);
  assert.equal(parsed.evidence?.[0].sha256, 'a'.repeat(64));
  assert.equal(parsed.evidence?.[1].url, 'https://e.com');
});

// --- S4: question groups ---

test('S4: a question validates with open/resolved states and rejects a type', () => {
  assert.equal(validateFrontmatter({ id: ID, kind: 'question', state: 'open', created: '2026-04-04T10:30:00Z', source: 'test', tags: [], check_by: 'never', answers: [OTHER], closed: true }).success, true);
  assert.equal(validateFrontmatter({ id: ID, kind: 'question', state: 'resolved', created: '2026-04-04T10:30:00Z', source: 'test', tags: [], check_by: 'never', answers: [OTHER], resolved_by: OTHER }).success, true);
  // question must not carry a type
  assert.equal(validateFrontmatter({ id: ID, kind: 'question', type: 'fact', state: 'open', created: '2026-04-04T10:30:00Z', source: 'test', tags: [], check_by: 'never' }).success, false);
  // question must use an open/resolved state
  assert.equal(validateFrontmatter({ id: ID, kind: 'question', state: 'active', created: '2026-04-04T10:30:00Z', source: 'test', tags: [], check_by: 'never' }).success, false);
});

test('S4: claims reject open/resolved states and question-only fields', () => {
  assert.equal(validateFrontmatter(base({ state: 'open' })).success, false);
  assert.equal(validateFrontmatter(base({ answers: [OTHER] })).success, false);
  assert.equal(validateFrontmatter(base({ closed: true })).success, false);
  assert.equal(validateFrontmatter(base({ resolved_by: OTHER })).success, false);
});

test('S4: createQuestion writes under memory/questions and validates answers', async () => {
  const { store, root } = await freshStore();
  const a = addClaim(store, 'AnsA');
  const b = addClaim(store, 'AnsB');
  const { id, filePath } = createQuestion(store, { title: 'Which db?', answers: [a.id, b.id], closed: true, source: 'test' });
  assert.ok(filePath.includes(join(QUESTIONS_SUBDIR)));
  assert.ok(existsSync(join(root, QUESTIONS_SUBDIR, `${id}.md`)));
  const q = store.findById(id)!;
  assert.equal(q.kind, 'question');
  assert.equal(q.state, 'open');
  assert.equal(q.closed, true);
  assert.deepEqual(q.answers, [a.id, b.id]);

  // A non-existent answer is rejected.
  assert.throws(() => createQuestion(store, { title: 'Bad', answers: ['ms_00000000000000000000000000'], closed: false, source: 'test' }), /answer not found/);
});

test('S4: elimination — closed question resolves by elimination, open never does', async () => {
  const { store } = await freshStore();
  const a = addClaim(store, 'ElimA');
  const b = addClaim(store, 'ElimB');
  const { id } = createQuestion(store, { title: 'Q closed?', answers: [a.id, b.id], closed: true, source: 'test' });
  const byId0 = new Map(store.loadAll().map((i) => [i.id, i]));
  assert.equal(eliminationStatus(store.findById(id)!, byId0).resolvableByElimination, false, 'two active answers → not resolvable');

  // Retire B by superseding it (move to archive -> superseded).
  store.moveToArchive({ ...b }, 'superseded');
  const byId1 = new Map(store.loadAll().map((i) => [i.id, i]));
  const closedStatus = eliminationStatus(store.findById(id)!, byId1);
  assert.equal(closedStatus.resolvableByElimination, true);
  assert.equal(closedStatus.survivor, a.id);

  // An OPEN-world question with one active answer never resolves by elimination.
  const openQ = createQuestion(store, { title: 'Q open?', answers: [a.id, b.id], closed: false, source: 'test' });
  assert.equal(eliminationStatus(store.findById(openQ.id)!, byId1).resolvableByElimination, false);
});

test('S4: addAnswers, setClosed, and resolveQuestion lifecycle', async () => {
  const { store } = await freshStore();
  const a = addClaim(store, 'LcA');
  const b = addClaim(store, 'LcB');
  const c = addClaim(store, 'LcC');
  const { id } = createQuestion(store, { title: 'Lifecycle?', answers: [a.id], closed: false, source: 'test' });

  addAnswers(store, id, [b.id, c.id]);
  assert.deepEqual(store.findById(id)!.answers, [a.id, b.id, c.id]);

  setClosed(store, id, true);
  assert.equal(store.findById(id)!.closed, true);

  // Cannot resolve with three active answers.
  assert.throws(() => resolveQuestion(store, id), /still active/);

  // Supersede b and c → a is the lone survivor.
  store.moveToArchive({ ...b }, 'superseded');
  store.moveToArchive({ ...c }, 'superseded');
  const { survivor } = resolveQuestion(store, id);
  assert.equal(survivor, a.id);
  const resolved = store.findById(id)!;
  assert.equal(resolved.state, 'resolved');
  assert.equal(resolved.resolved_by, a.id);
});

test('S4: assertAnswerCandidate rejects a retired answer', async () => {
  const { store } = await freshStore();
  const a = addClaim(store, 'RetA');
  store.moveToArchive({ ...a }, 'retired');
  assert.throws(() => assertAnswerCandidate(store, a.id), /must be active or superseded/);
});

// --- Panel remediation: #8/#22, #30, #24 ----------------------------------

test('#8/#22: a symlink pointing into local/ is refused (symlinked source), and a symlinked ancestor directory does not defeat the local/ guard', async () => {
  const { root } = await freshStore();
  await mkdir(join(root, 'local'), { recursive: true });
  const secret = join(root, 'local', 'secrets.env');
  await writeFile(secret, 'TOP_SECRET=abc\n');
  const outside = await mkdtemp(join(tmpdir(), 'memspec-ev-link-'));

  await symlink(secret, join(outside, 'notes.txt'));
  assert.throws(() => attachEvidence(root, join(outside, 'notes.txt')), /refusing symlinked evidence source/);

  await symlink(join(root, 'local'), join(outside, 'ldir'));
  assert.throws(() => attachEvidence(root, join(outside, 'ldir', 'secrets.env')), /refusing to copy evidence out of the local\/ subtree/);

  // Any symlinked source is refused, even a harmless one: what lands in the
  // committed evidence/ dir must be what the caller pointed at.
  const plain = join(outside, 'plain.txt');
  await writeFile(plain, 'plain');
  await symlink(plain, join(outside, 'plain-link.txt'));
  assert.throws(() => attachEvidence(root, join(outside, 'plain-link.txt')), /refusing symlinked evidence source/);
  assert.equal(existsSync(join(root, 'evidence')), false, 'nothing was copied');
});

test('#39: validateEvidenceSource decides every refusal without copying; attachEvidence copies only after it passes', async () => {
  const { root } = await freshStore();
  const dir = await mkdtemp(join(tmpdir(), 'memspec-ev-val-'));
  const good = join(dir, 'good.txt');
  await writeFile(good, 'ok');
  assert.deepEqual(validateEvidenceSource(root, 'https://example.com/x'), { kind: 'url', url: 'https://example.com/x' });
  assert.equal(validateEvidenceSource(root, good).kind, 'file');
  assert.throws(() => validateEvidenceSource(root, join(dir, 'missing.txt')), /evidence file not found/);
  assert.throws(() => validateEvidenceSource(root, dir), /not a regular file/);
  assert.equal(existsSync(join(root, 'evidence')), false, 'validation never copies');
});

test('#30: evidence source is recorded ~-relative under HOME, repo-relative inside a checkout, and omitted otherwise', async () => {
  const { homedir } = await import('node:os');
  const home = homedir();
  assert.equal(describeEvidenceSource(join(home, 'Documents', 'clients', 'x', 'report.pdf')), '~/Documents/clients/x/report.pdf');

  const base = await mkdtemp(join(tmpdir(), 'memspec-ev-src-'));
  await mkdir(join(base, 'repo', '.git', 'sub'), { recursive: true });
  await mkdir(join(base, 'repo', 'docs'), { recursive: true });
  await writeFile(join(base, 'repo', 'docs', 'proof.txt'), 'p');
  assert.equal(describeEvidenceSource(join(base, 'repo', 'docs', 'proof.txt')), 'repo:docs/proof.txt');

  await writeFile(join(base, 'loose.txt'), 'l');
  assert.equal(describeEvidenceSource(join(base, 'loose.txt')), undefined);

  const { root } = await freshStore();
  const entry = attachEvidence(root, join(base, 'repo', 'docs', 'proof.txt'));
  assert.equal(entry.source, 'repo:docs/proof.txt');
  assert.equal(entry.name, 'proof.txt');
  assert.ok(!entry.source!.startsWith('/'));
});

test('#24: adding a new active answer to a resolved question reopens it (state open, resolved_by cleared); a superseded or already-listed answer does not', async () => {
  const { store } = await freshStore();
  const a = addClaim(store, 'Reopen A');
  const b = addClaim(store, 'Reopen B');
  const { id: qid } = createQuestion(store, { title: 'Reopen?', answers: [a.id, b.id], closed: true, source: 'test' });
  store.moveToArchive({ ...store.findById(b.id)!, state: 'superseded' }, 'superseded');
  resolveQuestion(store, qid);
  assert.equal(store.findById(qid)!.state, 'resolved');
  assert.equal(store.findById(qid)!.resolved_by, a.id);

  // Re-adding the survivor, or a superseded answer, leaves resolution alone.
  addAnswers(store, qid, [a.id]);
  addAnswers(store, qid, [b.id]);
  assert.equal(store.findById(qid)!.state, 'resolved');
  assert.equal(store.findById(qid)!.resolved_by, a.id);

  const c = addClaim(store, 'Reopen C');
  const updated = addAnswers(store, qid, [c.id]);
  assert.equal(updated.state, 'open');
  assert.equal(updated.resolved_by, undefined);
  const reloaded = store.findById(qid)!;
  assert.equal(reloaded.state, 'open');
  assert.equal(reloaded.resolved_by, undefined);
  assert.deepEqual(reloaded.answers, [a.id, b.id, c.id]);
  assert.equal(eliminationStatus(reloaded, new Map(store.loadAll().map((i) => [i.id, i]))).state, 'open');
});

// --- Release-gate security side-pass (2026-09-16): evidence default-deny -----

test('SEC-1: evidence refuses hidden path components outside the store, secret-shaped names, and secret-bearing content; nothing is copied', async () => {
  const { root } = await freshStore();
  const dir = await mkdtemp(join(tmpdir(), 'memspec-ev-sec-'));
  const prevAllow = process.env.MEMSPEC_EVIDENCE_ALLOW_HIDDEN;
  delete process.env.MEMSPEC_EVIDENCE_ALLOW_HIDDEN;
  try {
    // ~/.ssh/id_rsa shape: hidden dir AND key name AND key content — the first check fires.
    await mkdir(join(dir, '.ssh'), { recursive: true });
    await writeFile(join(dir, '.ssh', 'id_rsa'), '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n');
    assert.throws(() => validateEvidenceSource(root, join(dir, '.ssh', 'id_rsa')), /refusing evidence from a hidden path .*"\.ssh"/);
    // A hidden dir with an innocent file is still refused (~/.aws/config, ~/.config/...).
    await mkdir(join(dir, '.aws'), { recursive: true });
    await writeFile(join(dir, '.aws', 'config'), '[default]\nregion=eu-north-1\n');
    assert.throws(() => validateEvidenceSource(root, join(dir, '.aws', 'config')), /hidden path/);
    // A dot-file in a visible dir (.env) is refused by both rules; hidden fires first.
    await writeFile(join(dir, '.env'), 'X=1\n');
    assert.throws(() => validateEvidenceSource(root, join(dir, '.env')), /hidden path/);
    // Secret-by-name in a visible location.
    await writeFile(join(dir, 'server.pem'), 'not really a key\n');
    assert.throws(() => validateEvidenceSource(root, join(dir, 'server.pem')), /looks like a secret by name \(server\.pem\)/);
    await writeFile(join(dir, 'credentials.json'), '{}\n');
    assert.throws(() => validateEvidenceSource(root, join(dir, 'credentials.json')), /looks like a secret by name/);
    // Secret-by-content in an innocent-looking file.
    await writeFile(join(dir, 'notes.md'), 'deploy key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----\n');
    assert.throws(() => validateEvidenceSource(root, join(dir, 'notes.md')), /content contains a private key/);
    await writeFile(join(dir, 'ci.log'), `token=ghp_${'a'.repeat(36)} used\n`);
    assert.throws(() => validateEvidenceSource(root, join(dir, 'ci.log')), /content contains a GitHub token/);
    await writeFile(join(dir, 'aws.txt'), 'AKIAABCDEFGHIJKLMNOP\n');
    assert.throws(() => validateEvidenceSource(root, join(dir, 'aws.txt')), /AWS access key id/);
    // Innocent file still passes, and attachEvidence never copied anything above.
    await writeFile(join(dir, 'report.md'), '# fine\nno secrets here\n');
    assert.equal(validateEvidenceSource(root, join(dir, 'report.md')).kind, 'file');
    for (const bad of ['.ssh/id_rsa', 'server.pem', 'notes.md']) {
      assert.throws(() => attachEvidence(root, join(dir, bad)));
    }
    assert.equal(existsSync(join(root, 'evidence')), false, 'nothing was copied');
    // The store itself may be a dot-directory (~/.memspec): files inside it are not "hidden".
    const storeParent = await mkdtemp(join(tmpdir(), 'memspec-ev-dot-'));
    const dotStore = new MemspecStore(join(storeParent, '.memspec'));
    dotStore.init();
    await mkdir(join(dotStore.root, 'dream'), { recursive: true });
    await writeFile(join(dotStore.root, 'dream', '2026-09-11.md'), '# dream pass\n');
    assert.equal(validateEvidenceSource(dotStore.root, join(dotStore.root, 'dream', '2026-09-11.md')).kind, 'file');
    // The hidden rule (only) can be lifted by the operator; the name/content rules cannot.
    process.env.MEMSPEC_EVIDENCE_ALLOW_HIDDEN = '1';
    assert.equal(validateEvidenceSource(root, join(dir, '.aws', 'config')).kind, 'file');
    assert.throws(() => validateEvidenceSource(root, join(dir, '.ssh', 'id_rsa')), /looks like a secret by name/);
  } finally {
    if (prevAllow === undefined) delete process.env.MEMSPEC_EVIDENCE_ALLOW_HIDDEN; else process.env.MEMSPEC_EVIDENCE_ALLOW_HIDDEN = prevAllow;
  }
});
