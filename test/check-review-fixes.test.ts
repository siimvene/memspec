// Review fixes for `memspec check` (0.13.0 panel): each test fails on the
// pre-fix build. Synthetic fixtures only (invoices, meters, a billing module).

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ulid } from 'ulid';
import { CheckUsageError, renderCheckText, runCheck } from '../src/commands/check.js';
import { runQuestion } from '../src/commands/question.js';
import { runRelate, runUnrelate } from '../src/commands/relate.js';
import { runRemember } from '../src/commands/remember.js';
import { runSupersede } from '../src/commands/supersede.js';
import { MemspecStore } from '../src/lib/store.js';
import type { MemoryFrontmatter, MemoryType } from '../src/lib/types.js';
import { makeTempProject, runCli } from './helpers.js';

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

async function cli(args: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const r = await runCli(args, cwd);
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

const ROUNDING = 'Invoice rounding follows banker convention';
const REFUNDS = 'Invoice rounding banker exceptions for refunds';

function pairKeys(report: ReturnType<typeof runCheck>): string[] {
  return report.pairs.map((p) => `${p.status}:${[p.a.id, p.b.id].sort().join('|')}`);
}

const key = (status: string, a: string, b: string): string => `${status}:${[a, b].sort().join('|')}`;

// --- S1: frontmatter-only skip ---

test('S1: an archived record revived into memory/ with identical content is checked (not skipped)', async () => {
  const project = await newStore();
  const a = addClaim(project, 'decision', ROUNDING);
  const b = addClaim(project, 'decision', REFUNDS);
  runSupersede(b.id, { cwd: project, reason: 'obsolete', source: 'test' });
  commitAll(project, 'main');
  branch(project);
  const archived = join(project, '.memspec', 'archive', `${b.id}.md`);
  const revived = raw(archived)
    .replace(/^state: superseded$/m, 'state: active')
    .replace(/^superseded_by:.*\n/m, '')
    .replace(/^supersede_reason:.*\n/m, '');
  writeFileSync(b.filePath, revived);
  unlinkSync(archived);
  const report = runCheck({ store: project, base: 'main' });
  assert.equal(report.ok, false, JSON.stringify(report));
  assert.deepEqual(report.checked, [b.id]);
  assert.equal(report.skipped_unchanged_content, 0);
  assert.deepEqual(pairKeys(report), [key('unacknowledged', a.id, b.id)]);
});

test('S1: a retired record flipped back to active in place is checked', async () => {
  const project = await newStore();
  addClaim(project, 'decision', ROUNDING);
  const b = addClaim(project, 'decision', REFUNDS, { extra: { state: 'retired' } });
  commitAll(project, 'main');
  branch(project);
  writeFileSync(b.filePath, raw(b.filePath).replace(/^state: retired$/m, 'state: active'));
  const report = runCheck({ store: project, base: 'main' });
  assert.equal(report.ok, false);
  assert.deepEqual(report.checked, [b.id]);
});

test('S1: removing the distinct_from acknowledgement (unrelate) makes the record checked and the pair fails', async () => {
  const project = await newStore();
  const a = addClaim(project, 'decision', ROUNDING);
  const b = addClaim(project, 'decision', REFUNDS);
  runRelate({ cwd: project, from: a.id, to: b.id, type: 'distinct_from' });
  commitAll(project, 'main');
  assert.equal(runCheck({ store: project, all: true }).ok, true);
  branch(project);
  runUnrelate({ cwd: project, from: a.id, to: b.id, type: 'distinct_from', reason: 'oops', source: 'test' });
  commitAll(project, 'drop ack');
  const report = runCheck({ store: project, base: 'main' });
  assert.equal(report.ok, false);
  assert.deepEqual(report.checked, [a.id]);
  assert.deepEqual(pairKeys(report), [key('unacknowledged', a.id, b.id)]);
});

test('S1: dropping an edge to a record that is no longer active stays a frontmatter-only skip (merge survivor)', async () => {
  const project = await newStore();
  const a = addClaim(project, 'decision', ROUNDING);
  addClaim(project, 'decision', REFUNDS);
  const meter = addClaim(project, 'fact', 'Meter readings are imported nightly');
  runRelate({ cwd: project, from: a.id, to: meter.id, type: 'distinct_from' });
  commitAll(project, 'main');
  branch(project);
  // M4 drops the survivor's distinct_from to the record it absorbs; the
  // survivor's pre-existing overlap with REFUNDS must not surface.
  runSupersede(a.id, { cwd: project, reason: 'same claim', mergeFrom: [meter.id], source: 'test' });
  const report = runCheck({ store: project, base: 'main' });
  assert.equal(report.ok, true, JSON.stringify(report.pairs));
  assert.deepEqual(report.checked, []);
  assert.equal(report.skipped_unchanged_content, 1);
});

test('S1: a frontmatter-only change of type, scope or validity window counts as content', async () => {
  for (const [field, from, to] of [
    ['type', 'type: decision', 'type: fact'],
    ['scope', 'scope: billing', 'scope: metering'],
    ['valid_to', "valid_to: '2030-01-01T00:00:00.000Z'", "valid_to: '2031-01-01T00:00:00.000Z'"],
  ] as const) {
    const project = await newStore();
    const extra: Partial<MemoryFrontmatter> =
      field === 'scope' ? { scope: 'billing' } : field === 'valid_to' ? { valid_to: '2030-01-01T00:00:00.000Z' } : {};
    const a = addClaim(project, 'decision', ROUNDING, { extra });
    addClaim(project, 'decision', REFUNDS);
    commitAll(project, 'main');
    branch(project);
    const before = raw(a.filePath);
    assert.ok(before.includes(from), `${field}: fixture carries "${from}"\n${before}`);
    writeFileSync(a.filePath, before.replace(from, to));
    const report = runCheck({ store: project, base: 'main' });
    assert.deepEqual(report.checked, [a.id], `${field} edit is content`);
    assert.equal(report.ok, false, field);
  }
});

test('S1: deleting the question record that filed both answers fails the pair', async () => {
  const project = await newStore();
  const a = addClaim(project, 'decision', ROUNDING);
  const b = addClaim(project, 'decision', REFUNDS);
  const q = runQuestion('Which rounding applies to refunds?', { cwd: project, answers: [a.id, b.id], source: 'test' });
  commitAll(project, 'main');
  assert.equal(runCheck({ store: project, all: true }).ok, true);
  branch(project);
  const qFile = git(project, 'ls-files', '.memspec').split('\n').find((f) => f.includes(q.id))!;
  git(project, 'rm', '--quiet', qFile);
  git(project, 'commit', '--quiet', '-m', 'delete question');
  const report = runCheck({ store: project, base: 'main' });
  assert.equal(report.ok, false, JSON.stringify(report));
  assert.deepEqual(pairKeys(report), [key('unacknowledged', a.id, b.id)]);
});

test('S1: a question edit that drops an answer re-checks that answer; adding an answer re-checks nothing', async () => {
  const project = await newStore();
  const a = addClaim(project, 'decision', ROUNDING);
  const b = addClaim(project, 'decision', REFUNDS);
  const c = addClaim(project, 'fact', 'Meter readings are imported nightly');
  const q = runQuestion('Which rounding applies to refunds?', { cwd: project, answers: [a.id, b.id], source: 'test' });
  commitAll(project, 'main');
  branch(project);

  runQuestion(q.id, { cwd: project, add: [c.id], source: 'test' });
  let report = runCheck({ store: project, base: 'main' });
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.deepEqual(report.checked, []);

  const qFile = join(project, git(project, 'ls-files', '.memspec').split('\n').find((f) => f.includes(q.id))!);
  writeFileSync(qFile, raw(qFile).replace(new RegExp(`^ *- ${b.id}\\n`, 'm'), ''));
  assert.ok(!raw(qFile).includes(b.id), 'answer removed from the question file');
  report = runCheck({ store: project, base: 'main' });
  assert.equal(report.ok, false);
  assert.deepEqual(report.checked, [b.id]);
  assert.deepEqual(pairKeys(report), [key('unacknowledged', a.id, b.id)]);
});

test('S1: deleting the ack-carrying copy of a record whose id still loads from another file fails the pair', async () => {
  const project = await newStore();
  const a = addClaim(project, 'decision', ROUNDING);
  const b = addClaim(project, 'decision', REFUNDS);
  // A second copy of `a` without the edge, in the standard tier; the operator
  // copy (which wins the load) carries the acknowledgement.
  const operatorCopy = join(project, '.memspec', 'memory', 'operator', 'decisions', `${a.id}.md`);
  mkdirSync(dirname(operatorCopy), { recursive: true });
  writeFileSync(operatorCopy, raw(a.filePath).replace(/^tags: \[\]$/m, `tags: []\ndistinct_from:\n  - ${b.id}`));
  commitAll(project, 'main');
  assert.deepEqual(new MemspecStore(project).findById(a.id)!.distinct_from, [b.id]);
  branch(project);
  git(project, 'rm', '--quiet', operatorCopy);
  git(project, 'commit', '--quiet', '-m', 'drop operator copy');
  const report = runCheck({ store: project, base: 'main' });
  assert.equal(report.ok, false, JSON.stringify(report));
  assert.deepEqual(pairKeys(report), [key('unacknowledged', a.id, b.id)]);
});

// --- S2: duplicate ids ---

test('S2: a PR adding a second file with an existing id is invalid whichever file the loader keeps', async () => {
  for (const dir of ['aaa', 'zzz']) {
    const project = await newStore();
    const x = addClaim(project, 'fact', 'Meter readings are imported nightly');
    commitAll(project, 'main');
    branch(project);
    const copy = join(project, '.memspec', 'memory', dir, `${x.id}.md`);
    mkdirSync(dirname(copy), { recursive: true });
    writeFileSync(copy, raw(x.filePath).replace(/Meter readings are imported nightly/g, 'Meter readings are imported hourly now'));
    const report = runCheck({ store: project, base: 'main' });
    assert.equal(report.ok, false, `${dir}: ${JSON.stringify(report)}`);
    const files = report.invalid.map((i) => i.file).sort();
    assert.deepEqual(files, [`.memspec/memory/${dir}/${x.id}.md`, `.memspec/memory/facts/${x.id}.md`].sort(), dir);
    for (const entry of report.invalid) assert.match(entry.reason, new RegExp(`duplicate record id ${x.id}`));
    // Loading is otherwise unchanged: duplicates are not load warnings.
    const store = new MemspecStore(project);
    store.loadAll();
    assert.deepEqual(store.warnings, []);
  }
});

test('S2: --all reports every duplicate id set', async () => {
  const project = await newStore();
  const x = addClaim(project, 'fact', 'Meter readings are imported nightly');
  const copy = join(project, '.memspec', 'memory', 'decisions', `${x.id}.md`);
  writeFileSync(copy, raw(x.filePath));
  const report = runCheck({ store: project, all: true });
  assert.equal(report.ok, false);
  // --all paths are relative to the store's parent directory.
  assert.deepEqual(report.invalid.map((i) => i.file).sort(), [`.memspec/memory/decisions/${x.id}.md`, `.memspec/memory/facts/${x.id}.md`]);
});

// --- S3: symlinks ---

test('S3: git mode refuses a store whose memory/ is a symlink (exit 2)', async () => {
  const project = await newStore();
  addClaim(project, 'decision', ROUNDING);
  commitAll(project, 'main');
  branch(project);
  const memory = join(project, '.memspec', 'memory');
  renameSync(memory, join(project, 'notes'));
  symlinkSync('../notes', memory);
  addClaim(project, 'decision', REFUNDS);
  commitAll(project, 'symlink');
  assert.throws(() => runCheck({ store: project, base: 'main' }), CheckUsageError);
  const res = await cli(['check', '--store', project, '--base', 'main']);
  assert.equal(res.code, 2, res.stdout + res.stderr);
  assert.match(res.stderr, /is a symlink/);
});

test('S3: a symlinked record file under memory/ is refused; a changed symlink elsewhere in the store is invalid', async () => {
  const project = await newStore();
  const a = addClaim(project, 'decision', ROUNDING);
  commitAll(project, 'main');
  branch(project);
  const link = join(project, '.memspec', 'memory', 'facts', `ms_${ulid()}.md`);
  symlinkSync(a.filePath, link);
  assert.throws(() => runCheck({ store: project, base: 'main' }), /is a symlink/);
  unlinkSync(link);

  symlinkSync(join(project, 'elsewhere.md'), join(project, '.memspec', 'notes.md'));
  const report = runCheck({ store: project, base: 'main' });
  assert.equal(report.ok, false);
  assert.deepEqual(report.invalid.map((i) => i.file), ['.memspec/notes.md']);
  assert.match(report.invalid[0].reason, /symlink/);
});

// --- S4: supersedes is not an acknowledgement ---

test('S4: a survivor whose supersedes names a still-active target is an unapplied_supersede', async () => {
  const project = await newStore();
  const t = addClaim(project, 'decision', ROUNDING);
  commitAll(project, 'main');
  branch(project);
  // A promote PR that copied the survivor but never archived the target.
  const s = addClaim(project, 'decision', REFUNDS, { extra: { supersedes: [t.id] } });
  const report = runCheck({ store: project, base: 'main' });
  assert.equal(report.ok, false);
  assert.deepEqual(pairKeys(report), [key('unapplied_supersede', s.id, t.id)]);
  assert.equal(report.pairs[0].a.id, s.id);
  const text = renderCheckText(report);
  assert.match(text, /UNAPPLIED SUPERSEDE/);
  assert.match(text, /the superseded record is still active; move it to archive\/ with state superseded and superseded_by, or let `memspec supersede` do it in this store/);

  // Applying the supersede (the target archived) clears it.
  const target = new MemspecStore(project).findById(t.id)!;
  new MemspecStore(project).moveToArchive({ ...target, superseded_by: s.id }, 'superseded');
  assert.equal(runCheck({ store: project, base: 'main' }).ok, true);
});

test('S4: unapplied_supersede needs no overlap signal', async () => {
  const project = await newStore();
  const t = addClaim(project, 'fact', 'Meter readings are imported nightly');
  commitAll(project, 'main');
  branch(project);
  const s = addClaim(project, 'decision', 'Invoice numbering restarts every calendar year', { extra: { supersedes: [t.id] } });
  assert.deepEqual(pairKeys(runCheck({ store: project, base: 'main' })), [key('unapplied_supersede', s.id, t.id)]);
  assert.deepEqual(pairKeys(runCheck({ store: project, all: true })), [key('unapplied_supersede', s.id, t.id)]);
});

// --- M1: linear title trim ---

test('M1: a 200 KB punctuation run in a title does not stall the check (< 2 s)', async () => {
  const project = await newStore();
  const id = `ms_${ulid()}`;
  const title = `x${'!'.repeat(200_000)}x`;
  writeFileSync(
    join(project, '.memspec', 'memory', 'facts', `${id}.md`),
    `---\nid: ${id}\nkind: claim\ntype: fact\nstate: active\ncreated: 2026-10-01T00:00:00.000Z\nsource: test\nsource_kind: agent\ntags: []\ncheck_by: never\nlast_verified: 2026-10-01T00:00:00.000Z\nverified_with: assertion\n---\n\n# ${title}\n\n${title}\n`,
  );
  addClaim(project, 'decision', ROUNDING);
  const started = Date.now();
  const report = runCheck({ store: project, all: true });
  const elapsed = Date.now() - started;
  assert.ok(report.checked.includes(id));
  assert.ok(elapsed < 2000, `took ${elapsed} ms`);
});

// --- M2: a store git never tracks ---

test('M2: a gitignored store is a usage error (exit 2), not "0 checked, ok"', async () => {
  const project = await newStore();
  writeFileSync(join(project, '.gitignore'), '.memspec/\n');
  commitAll(project, 'main');
  branch(project);
  addClaim(project, 'decision', ROUNDING);
  addClaim(project, 'decision', REFUNDS);
  assert.throws(() => runCheck({ store: project, base: 'main' }), /none of the 2 record file\(s\) .* is tracked by git/);
  const res = await cli(['check', '--store', project, '--base', 'main']);
  assert.equal(res.code, 2, res.stdout + res.stderr);
});

// --- M3: distinct_from exclusion in both directions ---

test('M3: relate refuses distinct_from when the TARGET lists the source on another edge, and vice versa', async () => {
  const project = await newStore();
  const a = addClaim(project, 'decision', ROUNDING);
  const b = addClaim(project, 'decision', REFUNDS);
  const c = addClaim(project, 'fact', 'Meter readings are imported nightly');
  runRelate({ cwd: project, from: b.id, to: a.id, type: 'refines' });
  assert.throws(
    () => runRelate({ cwd: project, from: a.id, to: b.id, type: 'distinct_from' }),
    new RegExp(`relate refuses distinct_from → ${b.id}: ${b.id} already declares refines to ${a.id}`),
  );
  runRelate({ cwd: project, from: c.id, to: a.id, type: 'distinct_from' });
  for (const type of ['refines', 'supports', 'depends_on', 'derived_from', 'conflicts_with'] as const) {
    assert.throws(
      () => runRelate({ cwd: project, from: a.id, to: c.id, type }),
      new RegExp(`relate refuses ${type} → ${c.id}: ${c.id} already declares distinct_from ${a.id}`),
      type,
    );
  }
  // supersedes counts as another edge too.
  const d = addClaim(project, 'fact', 'Meter calibration interval policy', { extra: { supersedes: [a.id] } });
  assert.throws(() => runRelate({ cwd: project, from: a.id, to: d.id, type: 'distinct_from' }), /already declares supersedes/);
  // remember applies the same rule.
  assert.throws(
    () => runRemember('fact', 'Invoice numbering per year', { cwd: project, source: 'test', distinctFrom: [a.id], refines: [a.id] }),
    /contradicts the refines edge/,
  );
});

// --- M4: supersede --merge-from ---

test('M4: supersede --merge-from drops the survivor distinct_from to the ids it now supersedes', async () => {
  const project = await newStore();
  const a = addClaim(project, 'decision', ROUNDING);
  const b = addClaim(project, 'decision', REFUNDS);
  const c = addClaim(project, 'fact', 'Meter readings are imported nightly');
  runRelate({ cwd: project, from: a.id, to: b.id, type: 'distinct_from' });
  runRelate({ cwd: project, from: a.id, to: c.id, type: 'distinct_from' });
  runSupersede(a.id, { cwd: project, reason: 'same claim', mergeFrom: [b.id], source: 'test' });
  const survivor = new MemspecStore(project).findById(a.id)!;
  assert.deepEqual(survivor.supersedes, [b.id]);
  assert.deepEqual(survivor.distinct_from, [c.id]);
});

function raw(path: string): string {
  return readFileSync(path, 'utf8');
}
