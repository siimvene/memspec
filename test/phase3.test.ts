import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import matter from 'gray-matter';
import { runRemember } from '../src/commands/remember.js';
import { runSupersede } from '../src/commands/supersede.js';
import { runObserve } from '../src/commands/observe.js';
import { runStatus, buildStatusReport } from '../src/commands/status.js';
import { buildLineage } from '../src/lib/lineage.js';
import { MemspecStore } from '../src/lib/store.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function makeProject(): Promise<string> {
  const target = await mkdtemp(join(tmpdir(), 'memspec-phase3-'));
  const store = new MemspecStore(target);
  store.init();
  return target;
}

// --- memspec_remember (inline anchors) ----------------------------------------

test('remember writes a fact with inline anchors and records anchor witness', async () => {
  const target = await makeProject();
  await writeFile(join(target, 'svc.ts'), 'console.log("hi")\n');
  // git init so blobSha works
  await execFileAsync('git', ['init', '-q'], { cwd: target });

  const result = runRemember('fact', 'Service entry point', {
    cwd: target,
    body: 'Logs greeting on boot',
    source: 'phase3-test',
    anchors: ['svc.ts'],
  });

  assert.equal(result.anchors.length, 1);
  assert.equal(result.anchors[0].file, 'svc.ts');
  assert.equal(result.verified_with, 'anchor');

  const factsDir = join(target, '.memspec', 'memory', 'facts');
  const [entry] = await readdir(factsDir);
  const onDisk = matter(await import('node:fs/promises').then((m) => m.readFile(join(factsDir, entry), 'utf8')));
  assert.deepEqual(onDisk.data.anchors, [{ file: 'svc.ts', sha: result.anchors[0].sha }]);
  assert.equal(onDisk.data.verified_with, 'anchor');
});

test('remember without anchors records assertion (or operator) witness', async () => {
  const target = await makeProject();

  const fromAgent = runRemember('decision', 'Picked X over Y', {
    cwd: target,
    body: 'Because Z',
    source: 'phase3-test',
  });
  assert.equal(fromAgent.verified_with, 'assertion');

  const fromOperator = runRemember('decision', 'Picked A over B', {
    cwd: target,
    body: 'Because C',
    source: 'human:siim',
  });
  assert.equal(fromOperator.verified_with, 'operator');
});

// --- memspec_supersede (merge_from collapses N→1) -----------------------------

test('supersede with merge_from collapses N to 1 with no replacement body', async () => {
  const target = await makeProject();

  const a = runRemember('fact', 'Duplicate A', { cwd: target, body: 'first', source: 'agent-x' });
  const b = runRemember('fact', 'Duplicate B', { cwd: target, body: 'second', source: 'agent-x' });
  const c = runRemember('fact', 'Duplicate C', { cwd: target, body: 'third', source: 'agent-x' });

  const result = runSupersede(a.id, {
    cwd: target,
    reason: 'B and C are duplicates of A',
    mergeFrom: [b.id, c.id],
    source: 'merge-test',
  });

  assert.equal(result.survivor_id, a.id);
  assert.deepEqual(result.superseded_ids.sort(), [b.id, c.id].sort());

  const store = new MemspecStore(target);
  const all = store.loadAll();
  const survivor = all.find((i) => i.id === a.id)!;
  assert.equal(survivor.state, 'active');
  assert.ok(survivor.supersedes?.includes(b.id));
  assert.ok(survivor.supersedes?.includes(c.id));

  const archivedB = all.find((i) => i.id === b.id)!;
  assert.equal(archivedB.state, 'superseded');
  assert.equal(archivedB.superseded_by, a.id);
  assert.equal(archivedB.supersede_reason, 'B and C are duplicates of A');

  const archivedC = all.find((i) => i.id === c.id)!;
  assert.equal(archivedC.state, 'superseded');
  assert.equal(archivedC.superseded_by, a.id);
});

test('supersede with body and merge_from mints a single replacement collapsing all inputs', async () => {
  const target = await makeProject();

  const a = runRemember('fact', 'Dup A', { cwd: target, body: '1', source: 'agent-x' });
  const b = runRemember('fact', 'Dup B', { cwd: target, body: '2', source: 'agent-x' });
  const c = runRemember('fact', 'Dup C', { cwd: target, body: '3', source: 'agent-x' });

  const result = runSupersede(a.id, {
    cwd: target,
    reason: 'rolled up',
    body: 'Unified account of A, B, C',
    title: 'Unified fact',
    mergeFrom: [b.id, c.id],
    source: 'merge-test',
  });

  assert.notEqual(result.survivor_id, a.id);
  assert.equal(result.superseded_ids.length, 3);

  const store = new MemspecStore(target);
  const all = store.loadAll();
  const survivor = all.find((i) => i.id === result.survivor_id)!;
  assert.equal(survivor.state, 'active');
  assert.equal(survivor.title, 'Unified fact');
  assert.deepEqual(survivor.supersedes?.sort(), [a.id, b.id, c.id].sort());

  for (const oldId of [a.id, b.id, c.id]) {
    const item = all.find((i) => i.id === oldId)!;
    assert.equal(item.state, 'superseded', `${oldId} should be superseded`);
    assert.equal(item.superseded_by, result.survivor_id);
  }
});

test('supersede retraction (no body, no merge_from) marks target superseded with reason', async () => {
  const target = await makeProject();

  const item = runRemember('fact', 'No longer true', {
    cwd: target,
    body: 'used to be true',
    source: 'agent-x',
  });

  const result = runSupersede(item.id, {
    cwd: target,
    reason: 'system was redesigned, this no longer applies',
    source: 'retraction-test',
  });

  assert.equal(result.survivor_id, item.id);
  assert.equal(result.superseded_ids.length, 1);

  const store = new MemspecStore(target);
  const archived = store.findById(item.id)!;
  assert.equal(archived.state, 'superseded');
  assert.equal(archived.supersede_reason, 'system was redesigned, this no longer applies');
  assert.equal(archived.superseded_by, undefined, 'retraction does not point at a survivor');
});

// --- memspec_observe ----------------------------------------------------------

test('observe writes an observation with default 7-day expires', async () => {
  const target = await makeProject();

  const result = runObserve({
    cwd: target,
    text: 'Tool returned 42\nfull context: redis ping was slow',
  });

  assert.equal(typeof result.id, 'string');
  assert.match(result.id, /^ms_/);
  assert.notEqual(result.expires, 'never');

  const expiresMs = Date.parse(result.expires);
  const expectedMs = Date.now() + 7 * 24 * 60 * 60 * 1000;
  assert.ok(Math.abs(expiresMs - expectedMs) < 60_000, 'expires should be ~7 days from now');

  const store = new MemspecStore(target);
  const item = store.findById(result.id)!;
  assert.equal(item.kind, 'observation');
  assert.equal(item.title, 'Tool returned 42');
  assert.equal(item.expires, result.expires);
});

test('observe accepts custom ttl', async () => {
  const target = await makeProject();

  const result = runObserve({ cwd: target, text: 'short-lived note', ttl: '24h' });
  const expiresMs = Date.parse(result.expires);
  const expectedMs = Date.now() + 24 * 60 * 60 * 1000;
  assert.ok(Math.abs(expiresMs - expectedMs) < 60_000, 'expires should be ~24h from now');
});

test('observe with ttl=never omits expires', async () => {
  const target = await makeProject();

  const result = runObserve({ cwd: target, text: 'permanent observation', ttl: 'never' });
  assert.equal(result.expires, 'never');

  const store = new MemspecStore(target);
  const item = store.findById(result.id)!;
  assert.equal(item.expires, undefined);
});

// --- memspec_status (absorbs validate, adds conflicts + sweep candidates) -----

test('status returns conflict report, sweep candidates, and schema violations', async () => {
  const target = await makeProject();

  // Two active facts with overlapping titles → title-overlap conflict.
  // First five normalised words match (status's title-overlap bucket) but
  // the full titles differ, so v0.4 Phase 5 high-band refusal (exact title
  // match) doesn't fire. The pair still surfaces in the status report.
  runRemember('fact', 'Auth uses JWT tokens issued', { cwd: target, body: 'JWT 15min', source: 'agent-1' });
  runRemember('fact', 'Auth uses JWT tokens issued nightly', { cwd: target, body: 'JWT refresh', source: 'agent-2' });

  // A stale-eligible sweep candidate: past TTL, no anchors, assertion witness.
  // Hand-write the file with stale: true and a past check_by.
  const factsDir = join(target, '.memspec', 'memory', 'facts');
  const sweepCandidate = `---
id: ms_01KSWEEPCANDDATE0000000000
kind: claim
type: fact
state: active
created: 2024-01-01T00:00:00.000Z
source: forgotten-agent
source_kind: agent
tags: []
check_by: 2024-04-01T00:00:00.000Z
stale: true
verified_with: assertion
---

# Forgotten fact

A claim nobody verified.
`;
  await writeFile(join(factsDir, 'stale.md'), sweepCandidate);

  // A schema-violating file.
  const broken = `---
id: not-a-ulid
type: nonsense
state: bogus
created: not-a-date
source: ''
tags: bad
check_by: never
---

# Broken

Should fail schema validation.
`;
  await writeFile(join(factsDir, 'broken.md'), broken);

  const { report } = buildStatusReport({ cwd: target });

  assert.ok(report.conflicts.length > 0, 'expected at least one conflict');
  assert.ok(
    report.conflicts.some((c) => c.reason === 'title-overlap'),
    'expected a title-overlap conflict between the two JWT facts',
  );

  assert.ok(report.sweepCandidates.length > 0, 'expected the stale assertion-only fact as a sweep candidate');
  assert.ok(report.sweepCandidates.some((c) => c.id === 'ms_01KSWEEPCANDDATE0000000000'));

  assert.ok(report.schemaViolations.length > 0, 'expected the broken file to surface as a schema violation');
  assert.ok(report.schemaViolations.some((v) => v.file.endsWith('broken.md')));

  // The rendered text covers the same sections.
  const text = runStatus({ cwd: target });
  assert.match(text, /conflict\(s\) detected/);
  assert.match(text, /sweep candidate/);
  assert.match(text, /schema violation/);
});

test('status counts by witness reflect anchored vs assertion claims', async () => {
  const target = await makeProject();
  await writeFile(join(target, 'mod.ts'), 'export const X = 1\n');

  runRemember('fact', 'Anchored claim', { cwd: target, body: 'b', source: 'agent-x', anchors: ['mod.ts'] });
  runRemember('fact', 'Asserted claim', { cwd: target, body: 'b', source: 'agent-x' });
  runRemember('decision', 'Operator decision', { cwd: target, body: 'b', source: 'human:siim' });

  const { report } = buildStatusReport({ cwd: target });
  assert.equal(report.byWitness.anchor, 1);
  assert.equal(report.byWitness.assertion, 1);
  assert.equal(report.byWitness.operator, 1);
});

// --- memspec_get lineage chain ------------------------------------------------

test('lineage chain follows supersedes (ancestors) and superseded_by (descendants)', async () => {
  const target = await makeProject();

  const original = runRemember('fact', 'V1 of the claim', { cwd: target, body: 'v1', source: 'agent-x' });

  const replacement1 = runSupersede(original.id, {
    cwd: target,
    reason: 'v2 is sharper',
    body: 'V2 content',
    source: 'agent-x',
  });

  const replacement2 = runSupersede(replacement1.survivor_id, {
    cwd: target,
    reason: 'v3 corrects v2',
    body: 'V3 content',
    source: 'agent-x',
  });

  const store = new MemspecStore(target);
  const all = store.loadAll();

  // The survivor (v3) has v1 and v2 in its ancestry, no descendants.
  const v3 = all.find((i) => i.id === replacement2.survivor_id)!;
  const v3Lineage = buildLineage(v3, all);
  assert.equal(v3Lineage.descendants.length, 0);
  const v3AncestorIds = v3Lineage.ancestors.map((a) => a.id);
  assert.ok(v3AncestorIds.includes(replacement1.survivor_id));
  assert.ok(v3AncestorIds.includes(original.id));

  // The original (v1) sees v2 then v3 as descendants.
  const v1 = all.find((i) => i.id === original.id)!;
  const v1Lineage = buildLineage(v1, all);
  assert.equal(v1Lineage.ancestors.length, 0);
  const v1DescendantIds = v1Lineage.descendants.map((d) => d.id);
  assert.deepEqual(v1DescendantIds, [replacement1.survivor_id, replacement2.survivor_id]);
});
