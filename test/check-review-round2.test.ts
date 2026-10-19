// Second review round for `memspec check` (0.13.0): each test fails on
// 6de860d. Synthetic fixtures only (invoices, meters, a billing module).

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ulid } from 'ulid';
import { runCheck } from '../src/commands/check.js';
import { runQuestion } from '../src/commands/question.js';
import { runUnrelate } from '../src/commands/relate.js';
import { runVerify } from '../src/commands/verify.js';
import { MemspecStore } from '../src/lib/store.js';
import type { MemoryFrontmatter, MemoryType } from '../src/lib/types.js';
import { makeTempProject } from './helpers.js';

function git(cwd: string, ...args: string[]): string {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@test',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@test',
  };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[name];
  return execFileSync('git', args, { cwd, env, encoding: 'utf8' });
}

interface Rec {
  id: string;
  filePath: string;
}

function addClaim(
  project: string,
  type: MemoryType,
  title: string,
  opts: { body?: string; anchors?: string[]; extra?: Partial<MemoryFrontmatter> } = {},
): Rec {
  const store = new MemspecStore(project);
  const id = `ms_${ulid()}`;
  const now = new Date().toISOString();
  const filePath = store.writeItem({
    id,
    kind: 'claim',
    type,
    state: 'active',
    created: now,
    source: 'test',
    source_kind: 'agent',
    tags: [],
    check_by: 'never',
    last_verified: now,
    verified_with: opts.anchors ? 'anchor' : 'assertion',
    ...(opts.anchors ? { anchors: opts.anchors.map((file) => ({ file, sha: '0'.repeat(40) })) } : {}),
    ...opts.extra,
    title,
    body: opts.body ?? `${title}.`,
  });
  return { id, filePath };
}

async function newStore(): Promise<string> {
  const project = await makeTempProject();
  git(project, 'init', '--quiet', '-b', 'main');
  new MemspecStore(project).init();
  return project;
}

function commitAll(project: string, message: string): void {
  git(project, 'add', '-A');
  git(project, 'commit', '--quiet', '--allow-empty', '-m', message);
}

function branch(project: string): void {
  git(project, 'checkout', '--quiet', '-b', 'feature');
}

const ROUNDING = 'Invoice rounding follows banker convention';
const REFUNDS = 'Invoice rounding banker exceptions for refunds';

function pairKeys(report: ReturnType<typeof runCheck>): string[] {
  return report.pairs.map((p) => `${p.status}:${[p.a.id, p.b.id].sort().join('|')}`);
}

const key = (status: string, a: string, b: string): string => `${status}:${[a, b].sort().join('|')}`;


// --- R1: removing conflicts_with is a content change ---

test('R1: unrelating a conflicts_with to a still-active record re-checks the record and the pair fails', async () => {
  const project = await newStore();
  const b = addClaim(project, 'decision', REFUNDS);
  const a = addClaim(project, 'decision', ROUNDING, { extra: { conflicts_with: [b.id] } });
  commitAll(project, 'main');
  branch(project);
  runUnrelate({ cwd: project, from: a.id, to: b.id, type: 'conflicts_with', reason: 'legacy heuristic edge', source: 'test' });
  commitAll(project, 'drop conflict');
  const report = runCheck({ store: project, base: 'main' });
  assert.equal(report.ok, false, JSON.stringify(report));
  assert.deepEqual(report.checked, [a.id]);
  assert.equal(report.skipped_unchanged_content, 0);
  assert.deepEqual(pairKeys(report), [key('unacknowledged', a.id, b.id)]);
});

// --- R2: incoming conflicts_with ---

test('R2: a changed record that an unchanged active record declares conflicts_with is a declared_conflict', async () => {
  const project = await newStore();
  const b = addClaim(project, 'fact', 'Meter readings are imported nightly');
  addClaim(project, 'fact', 'Invoices are numbered per calendar year', { extra: { conflicts_with: [b.id] } });
  commitAll(project, 'main');
  branch(project);
  runVerify(b.id, { cwd: project, source: 'test', evidence: 'read the import job' });
  const report = runCheck({ store: project, base: 'main' });
  assert.equal(report.ok, false, JSON.stringify(report));
  assert.equal(report.pairs.length, 1);
  assert.equal(report.pairs[0].status, 'declared_conflict');
  assert.equal(report.pairs[0].a.id, b.id);
});

test('R2: the incoming declared conflict clears when both are filed in one question group', async () => {
  const project = await newStore();
  const b = addClaim(project, 'fact', 'Meter readings are imported nightly');
  const a = addClaim(project, 'fact', 'Invoices are numbered per calendar year', { extra: { conflicts_with: [b.id] } });
  runQuestion('Which import cadence?', { cwd: project, answers: [a.id, b.id], source: 'test' });
  commitAll(project, 'main');
  branch(project);
  runVerify(b.id, { cwd: project, source: 'test', evidence: 'read the import job' });
  assert.equal(runCheck({ store: project, base: 'main' }).ok, true);
});

// --- R3: every duplicate-id set is invalid in git mode ---

test('R3: an unchanged duplicate id set already on main is invalid in git mode too', async () => {
  const project = await newStore();
  const x = addClaim(project, 'fact', 'Meter readings are imported nightly');
  const copy = join(project, '.memspec', 'memory', 'decisions', `${x.id}.md`);
  writeFileSync(copy, raw(x.filePath).replace(/Meter readings are imported nightly/g, 'Invoice rounding banker exceptions for refunds'));
  commitAll(project, 'main');
  branch(project);
  addClaim(project, 'decision', ROUNDING);
  const report = runCheck({ store: project, base: 'main' });
  assert.equal(report.ok, false, JSON.stringify(report));
  assert.deepEqual(report.invalid.map((i) => i.file).sort(), [`.memspec/memory/decisions/${x.id}.md`, `.memspec/memory/facts/${x.id}.md`]);
});

// --- R4: base index covers record directories only ---

test('R4: a <id>.md under evidence/ at the merge-base is not the base version of a new record', async () => {
  const project = await newStore();
  addClaim(project, 'decision', ROUNDING);
  // A record file written, then parked under evidence/ on main (not a record directory).
  const parked = addClaim(project, 'decision', REFUNDS);
  const evidence = join(project, '.memspec', 'evidence', 'a'.repeat(64), `${parked.id}.md`);
  mkdirSync(dirname(evidence), { recursive: true });
  writeFileSync(evidence, raw(parked.filePath));
  const content = raw(parked.filePath);
  unlinkSync(parked.filePath);
  commitAll(project, 'main');
  branch(project);
  // The PR adds the record for real, byte-identical to the evidence copy.
  writeFileSync(parked.filePath, content);
  const report = runCheck({ store: project, base: 'main' });
  assert.deepEqual(report.checked, [parked.id], JSON.stringify(report));
  assert.equal(report.skipped_unchanged_content, 0);
  assert.equal(report.ok, false);
});

// --- R5: distinct_from next to another edge to the same target ---

test('R5: a record listing the same target in distinct_from and another edge list is invalid and acknowledges nothing', async () => {
  const project = await newStore();
  const y = addClaim(project, 'decision', ROUNDING);
  commitAll(project, 'main');
  branch(project);
  const x = addClaim(project, 'decision', REFUNDS, { extra: { distinct_from: [y.id], refines: [y.id] } });

  for (const report of [runCheck({ store: project, base: 'main' }), runCheck({ store: project, all: true })]) {
    assert.equal(report.ok, false, report.mode);
    assert.equal(report.invalid.length, 1, report.mode);
    assert.match(report.invalid[0].file, new RegExp(`${x.id}\\.md$`));
    assert.match(report.invalid[0].reason, new RegExp(`${x.id} lists ${y.id} in distinct_from and in refines`));
    assert.deepEqual(pairKeys(report), [key('unacknowledged', x.id, y.id)], report.mode);
  }
});

function raw(path: string): string {
  return readFileSync(path, 'utf8');
}
