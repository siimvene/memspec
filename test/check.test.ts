import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ulid } from 'ulid';
import {
  computeTitleTerms,
  CheckUsageError,
  DF_FILTER_MIN_CLAIMS,
  runCheck,
  renderCheckText,
} from '../src/commands/check.js';
import { runQuestion } from '../src/commands/question.js';
import { runRelate, runUnrelate } from '../src/commands/relate.js';
import { runSupersede } from '../src/commands/supersede.js';
import { runVerify } from '../src/commands/verify.js';
import { MemspecStore } from '../src/lib/store.js';
import type { MemoryFrontmatter, MemoryType } from '../src/lib/types.js';
import { makeTempProject, runCli } from './helpers.js';

// Synthetic fixtures only (invoices, meters, a billing module): this repo is public.

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

async function newStore(withGit: boolean): Promise<string> {
  const project = await makeTempProject();
  if (withGit) git(project, 'init', '--quiet', '-b', 'main');
  new MemspecStore(project).init();
  return project;
}

function commitAll(project: string, message: string): void {
  git(project, 'add', '-A');
  git(project, 'commit', '--quiet', '--allow-empty', '-m', message);
}

/**
 * The shape that motivated the check: an UNANCHORED fact whose body names the
 * billing module, and a decision anchored to that module. Different types,
 * different titles, two shared distinctive title terms (tariff, meter), and
 * a title overlap of 0.4, so only the file signal can catch the pair.
 */
async function billingRepo(): Promise<{ project: string; fact: Rec; decision: Rec }> {
  const project = await newStore(true);
  const fact = addClaim(project, 'fact', 'Distribution charges only meters that have a tariff row', {
    body: 'The distributor in src/billing/distributor.py skips meters without a tariff row.',
  });
  commitAll(project, 'main: billing fact');
  git(project, 'checkout', '--quiet', '-b', 'feature');
  const decision = addClaim(project, 'decision', 'Empty tariff table bills every meter', {
    body: 'With no tariff rows at all, every meter participates in the distribution.',
    anchors: ['src/billing/distributor.py'],
  });
  commitAll(project, 'feature: billing decision');
  return { project, fact, decision };
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

// --- 1. the real-case shape ---

test('check flags an unanchored fact naming a file against a decision anchored to it (git mode, branch vs main)', async () => {
  const { project, fact, decision } = await billingRepo();
  const report = runCheck({ store: project, base: 'main' });
  assert.equal(report.ok, false);
  assert.equal(report.mode, 'git');
  assert.deepEqual(report.checked, [decision.id]);
  assert.equal(report.pairs.length, 1);
  const pair = report.pairs[0];
  assert.equal(pair.status, 'unacknowledged');
  assert.equal(pair.a.id, decision.id);
  assert.equal(pair.b.id, fact.id);
  assert.equal(pair.a.type, 'decision');
  assert.equal(pair.b.type, 'fact');
  assert.deepEqual(pair.signals.shared_anchor, []);
  assert.deepEqual(pair.signals.path_mention, ['src/billing/distributor.py']);
  assert.deepEqual(pair.signals.title_terms, ['meter', 'tariff']);
  assert.equal(pair.signals.overlap, 0.4);
  assert.match(pair.a.file, /^\.memspec\/memory\/decisions\/ms_[A-Z0-9]{26}\.md$/);

  const text = renderCheckText(report);
  assert.match(text, /UNACKNOWLEDGED OVERLAP/);
  assert.ok(text.includes(`memspec relate --from ${decision.id} --to ${fact.id} --type distinct_from`));
  assert.ok(text.includes(`memspec question "<title>" --answers ${decision.id} ${fact.id}`));
  assert.match(text, /memspec check: 1 record\(s\) checked, 1 finding\(s\)$/);
});

test('control: the same pair without the file mention is not flagged (2 shared terms, no file signal)', async () => {
  const project = await newStore(true);
  addClaim(project, 'fact', 'Distribution charges only meters that have a tariff row', { body: 'Skips meters without a tariff row.' });
  commitAll(project, 'main');
  git(project, 'checkout', '--quiet', '-b', 'feature');
  addClaim(project, 'decision', 'Empty tariff table bills every meter', { anchors: ['src/billing/distributor.py'] });
  const report = runCheck({ store: project, base: 'main' });
  assert.equal(report.ok, true);
  assert.equal(report.checked.length, 1);
  assert.deepEqual(report.pairs, []);
  assert.match(renderCheckText(report), /memspec check: 1 record\(s\) checked, ok$/);
});

test('a shared anchor is a file signal too', async () => {
  const project = await newStore(true);
  addClaim(project, 'fact', 'Distribution charges only meters that have a tariff row', { anchors: ['src/billing/distributor.py'] });
  commitAll(project, 'main');
  git(project, 'checkout', '--quiet', '-b', 'feature');
  addClaim(project, 'decision', 'Empty tariff table bills every meter', { anchors: ['src/billing/distributor.py'] });
  const report = runCheck({ store: project, base: 'main' });
  assert.equal(report.pairs.length, 1);
  assert.deepEqual(report.pairs[0].signals.shared_anchor, ['src/billing/distributor.py']);
});

// --- 2. acknowledgement ---

test('relate --type distinct_from acknowledges the pair', async () => {
  const { project, decision, fact } = await billingRepo();
  runRelate({ cwd: project, from: decision.id, to: fact.id, type: 'distinct_from' });
  const report = runCheck({ store: project, base: 'main' });
  assert.equal(report.ok, true, JSON.stringify(report.pairs));
});

test('distinct_from written on the OTHER record (reverse direction) acknowledges too', async () => {
  const { project, decision, fact } = await billingRepo();
  runRelate({ cwd: project, from: fact.id, to: decision.id, type: 'distinct_from' });
  assert.equal(runCheck({ store: project, base: 'main' }).ok, true);
});

test('a positive edge (refines) acknowledges the pair', async () => {
  const { project, decision, fact } = await billingRepo();
  runRelate({ cwd: project, from: decision.id, to: fact.id, type: 'refines' });
  assert.equal(runCheck({ store: project, base: 'main' }).ok, true);
});

test('superseding one record clears the pair', async () => {
  const { project, fact } = await billingRepo();
  runSupersede(fact.id, { cwd: project, reason: 'replaced by the empty-table decision', source: 'test' });
  const report = runCheck({ store: project, base: 'main' });
  assert.equal(report.ok, true, JSON.stringify(report.pairs));
});

test('merging one into the other (supersedes edge on the survivor) clears the pair', async () => {
  const { project, fact, decision } = await billingRepo();
  runSupersede(decision.id, { cwd: project, reason: 'same rule', mergeFrom: [fact.id], source: 'test' });
  assert.equal(runCheck({ store: project, base: 'main' }).ok, true);
});

test('filing both in a question group acknowledges the pair', async () => {
  const { project, fact, decision } = await billingRepo();
  runQuestion('Which meters does an empty tariff table bill?', { cwd: project, answers: [fact.id, decision.id], source: 'test' });
  assert.equal(runCheck({ store: project, base: 'main' }).ok, true);
});

test('conflicts_with does not acknowledge: the pair is a declared_conflict and fails', async () => {
  const { project, fact, decision } = await billingRepo();
  runRelate({ cwd: project, from: decision.id, to: fact.id, type: 'conflicts_with' });
  const report = runCheck({ store: project, base: 'main' });
  assert.equal(report.ok, false);
  assert.equal(report.pairs.length, 1);
  assert.equal(report.pairs[0].status, 'declared_conflict');
  assert.match(renderCheckText(report), /DECLARED CONFLICT/);
  // The fix path: file both in a question group.
  runQuestion('Which meters does an empty tariff table bill?', { cwd: project, answers: [fact.id, decision.id], source: 'test' });
  assert.equal(runCheck({ store: project, base: 'main' }).ok, true);
});

test('a frontmatter-only edit that adds conflicts_with to an active record fails even without a pair signal', async () => {
  const project = await newStore(true);
  const a = addClaim(project, 'fact', 'Invoices are numbered per calendar year');
  const b = addClaim(project, 'decision', 'Meter readings are imported nightly');
  commitAll(project, 'main');
  git(project, 'checkout', '--quiet', '-b', 'feature');
  runRelate({ cwd: project, from: a.id, to: b.id, type: 'conflicts_with' });
  const report = runCheck({ store: project, base: 'main' });
  assert.equal(report.ok, false);
  assert.deepEqual(report.checked, []); // content unchanged
  assert.equal(report.skipped_unchanged_content, 1);
  assert.equal(report.pairs.length, 1);
  assert.equal(report.pairs[0].status, 'declared_conflict');
  assert.equal(report.pairs[0].a.id, a.id);
});

test('touching a record that already carries conflicts_with to an active record fails', async () => {
  const project = await newStore(true);
  const b = addClaim(project, 'decision', 'Meter readings are imported nightly');
  const a = addClaim(project, 'fact', 'Invoices are numbered per calendar year', { extra: { conflicts_with: [b.id] } });
  commitAll(project, 'main');
  git(project, 'checkout', '--quiet', '-b', 'feature');
  assert.equal(runCheck({ store: project, base: 'main' }).ok, true, 'untouched pre-existing conflict is not this change set');
  runVerify(a.id, { cwd: project, source: 'test', evidence: 'read the invoice module' });
  const report = runCheck({ store: project, base: 'main' });
  assert.equal(report.ok, false);
  assert.equal(report.pairs[0].status, 'declared_conflict');
});

// --- 3. title-only rule ---

test('title-only rule: >=3 shared terms with overlap >=0.5 flags two unanchored decisions; 2 shared terms do not', async () => {
  const project = await newStore(false);
  const a = addClaim(project, 'decision', 'Invoice rounding follows banker convention');
  const b = addClaim(project, 'decision', 'Invoice rounding banker exceptions for refunds');
  const c = addClaim(project, 'decision', 'Meter calibration interval policy');
  const d = addClaim(project, 'decision', 'Meter calibration tolerance limits');
  const report = runCheck({ store: project, all: true });
  assert.equal(report.mode, 'all');
  const keys = report.pairs.map((p) => [p.a.id, p.b.id].sort().join('|'));
  assert.deepEqual(keys, [[a.id, b.id].sort().join('|')]);
  assert.deepEqual(report.pairs[0].signals.title_terms, ['banker', 'invoic', 'round']);
  assert.equal(report.pairs[0].signals.overlap, 0.6);
  assert.ok(!keys.includes([c.id, d.id].sort().join('|')));
});

// --- 4. document-frequency filter ---

function fillerTitle(i: number): string {
  // Distinct letter-only words per filler, so fillers never pair with anything.
  const letters = 'bcdfghjklmnpqrstvwxz';
  const w = (n: number): string => `${letters[n % 20]}${letters[Math.floor(n / 20) % 20]}o${letters[(n * 7) % 20]}`;
  return `Zq${w(i * 3)}k ${w(i * 3 + 1)}vu ${w(i * 3 + 2)}ya`;
}

test(`document-frequency filter: a term in >5% of titles stops counting once the store has >= ${DF_FILTER_MIN_CLAIMS} active claims`, async () => {
  const build = async (total: number): Promise<{ project: string; a: Rec; b: Rec }> => {
    const project = await newStore(false);
    const a = addClaim(project, 'decision', 'Invoice rounding follows banker convention');
    const b = addClaim(project, 'decision', 'Invoice rounding banker exceptions for refunds');
    // Three more titles carrying "invoice": 5 of `total` titles.
    addClaim(project, 'fact', 'Invoice archive retention');
    addClaim(project, 'fact', 'Invoice email footer');
    addClaim(project, 'fact', 'Invoice PDF watermark');
    for (let i = 0; i < total - 5; i++) addClaim(project, 'fact', fillerTitle(i));
    return { project, a, b };
  };

  const big = await build(DF_FILTER_MIN_CLAIMS);
  const bigReport = runCheck({ store: big.project, all: true });
  assert.deepEqual(bigReport.pairs, [], 'invoic is in 5/40 titles (> 5%) and drops out, leaving 2 shared terms');

  const small = await build(DF_FILTER_MIN_CLAIMS - 1);
  const smallReport = runCheck({ store: small.project, all: true });
  assert.equal(smallReport.pairs.length, 1, 'below the size floor the same term still counts');
  assert.deepEqual(smallReport.pairs[0].signals.title_terms, ['banker', 'invoic', 'round']);
});

test('computeTitleTerms drops stopwords, short words, digit tokens and edge punctuation', () => {
  const [terms] = computeTitleTerms(['The 2026 invoices: "rounding" v2 is on a banker-style rule']);
  assert.deepEqual([...terms].sort(), ['banker', 'invoic', 'round', 'rule', 'style']);
});

// --- 5. git-mode scoping ---

test('a pre-existing unacknowledged pair on main is not reported when the branch adds an unrelated record', async () => {
  const project = await newStore(true);
  addClaim(project, 'decision', 'Invoice rounding follows banker convention');
  addClaim(project, 'decision', 'Invoice rounding banker exceptions for refunds');
  commitAll(project, 'main');
  git(project, 'checkout', '--quiet', '-b', 'feature');
  const unrelated = addClaim(project, 'fact', 'Meter readings are imported nightly');
  commitAll(project, 'feature');
  const report = runCheck({ store: project, base: 'main' });
  assert.equal(report.ok, true);
  assert.deepEqual(report.checked, [unrelated.id]);
  // ... while --all still sees it.
  assert.equal(runCheck({ store: project, all: true }).pairs.length, 1);
});

test('untracked and uncommitted record files count', async () => {
  const project = await newStore(true);
  const a = addClaim(project, 'decision', 'Invoice rounding follows banker convention');
  const filler = addClaim(project, 'fact', 'Meter readings are imported nightly');
  commitAll(project, 'main');
  git(project, 'checkout', '--quiet', '-b', 'feature');

  // Untracked new file.
  const b = addClaim(project, 'decision', 'Invoice rounding banker exceptions for refunds');
  let report = runCheck({ store: project, base: 'main' });
  assert.deepEqual(report.checked, [b.id]);
  assert.equal(report.pairs.length, 1);

  // Uncommitted body edit to a committed record turns it into a checked record.
  git(project, 'clean', '-fdq');
  assert.equal(runCheck({ store: project, base: 'main' }).ok, true);
  const raw = readFileSync(filler.filePath, 'utf8');
  writeFileSync(filler.filePath, raw.replace('# Meter readings are imported nightly', '# Invoice rounding banker meter readings'));
  report = runCheck({ store: project, base: 'main' });
  assert.deepEqual(report.checked, [filler.id]);
  assert.equal(report.pairs.length, 1);
  assert.deepEqual([report.pairs[0].a.id, report.pairs[0].b.id], [filler.id, a.id]);
});

test('frontmatter-only edits (verify, relate) on a record with a pre-existing overlap pass; a body edit is checked and fails', async () => {
  const project = await newStore(true);
  const a = addClaim(project, 'decision', 'Invoice rounding follows banker convention');
  addClaim(project, 'decision', 'Invoice rounding banker exceptions for refunds');
  const other = addClaim(project, 'fact', 'Meter readings are imported nightly');
  commitAll(project, 'main');
  git(project, 'checkout', '--quiet', '-b', 'feature');

  runVerify(a.id, { cwd: project, source: 'test', evidence: 'read the invoice module' });
  runRelate({ cwd: project, from: a.id, to: other.id, type: 'supports' });
  commitAll(project, 'triage');
  let report = runCheck({ store: project, base: 'main' });
  assert.equal(report.ok, true, JSON.stringify(report.pairs));
  assert.deepEqual(report.checked, []);
  assert.equal(report.skipped_unchanged_content, 1);
  assert.match(renderCheckText(report), /Skipped 1 changed record file\(s\) with frontmatter-only edits/);

  const raw = readFileSync(a.filePath, 'utf8');
  writeFileSync(a.filePath, raw.replace(/\n*$/, '\n\nRounding happens per line, not per invoice total.\n'));
  report = runCheck({ store: project, base: 'main' });
  assert.equal(report.ok, false);
  assert.deepEqual(report.checked, [a.id]);
  assert.equal(report.skipped_unchanged_content, 0);
});

test('a record moved between directories with identical content passes; moved and edited is checked', async () => {
  const project = await newStore(true);
  const a = addClaim(project, 'decision', 'Invoice rounding follows banker convention');
  addClaim(project, 'decision', 'Invoice rounding banker exceptions for refunds');
  commitAll(project, 'main');
  git(project, 'checkout', '--quiet', '-b', 'feature');

  const moved = join(project, '.memspec', 'memory', 'operator', 'decisions', `${a.id}.md`);
  mkdirSync(dirname(moved), { recursive: true });
  renameSync(a.filePath, moved);
  let report = runCheck({ store: project, base: 'main' });
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(report.skipped_unchanged_content, 1, 'the moved file is in the change set, its content is not new');

  writeFileSync(moved, readFileSync(moved, 'utf8').replace(/\n*$/, '\n\nEdited after the move.\n'));
  report = runCheck({ store: project, base: 'main' });
  assert.deepEqual(report.checked, [a.id]);
  assert.equal(report.pairs.length, 1);
});

test('an archived (superseded) record is not checked', async () => {
  const project = await newStore(true);
  addClaim(project, 'decision', 'Invoice rounding follows banker convention');
  const b = addClaim(project, 'decision', 'Invoice rounding banker exceptions for refunds');
  commitAll(project, 'main');
  git(project, 'checkout', '--quiet', '-b', 'feature');
  runSupersede(b.id, { cwd: project, reason: 'obsolete', source: 'test' });
  const report = runCheck({ store: project, base: 'main' });
  assert.equal(report.ok, true);
  assert.deepEqual(report.checked, []);
});

test('with no --base the remote default branch is used', async () => {
  const { project, decision } = await billingRepo();
  git(project, 'update-ref', 'refs/remotes/origin/main', 'main');
  const report = runCheck({ store: project });
  assert.equal(report.base, 'origin/main');
  assert.equal(report.merge_base, git(project, 'rev-parse', 'main').trim());
  assert.deepEqual(report.checked, [decision.id]);
});

// --- 6. invalid files, usage errors ---

test('an invalid changed record file is a finding (exit 1)', async () => {
  const project = await newStore(true);
  addClaim(project, 'fact', 'Meter readings are imported nightly');
  commitAll(project, 'main');
  git(project, 'checkout', '--quiet', '-b', 'feature');
  const bad = join(project, '.memspec', 'memory', 'facts', `ms_${ulid()}.md`);
  writeFileSync(bad, '---\nid: not-an-id\nkind: claim\n---\n# Broken\n');
  const report = runCheck({ store: project, base: 'main' });
  assert.equal(report.ok, false);
  assert.equal(report.invalid.length, 1);
  assert.match(report.invalid[0].file, /^\.memspec\/memory\/facts\/ms_[A-Z0-9]{26}\.md$/);
  assert.match(report.invalid[0].reason, /Invalid frontmatter/);

  const res = await cli(['check', '--store', project, '--base', 'main']);
  assert.equal(res.code, 1);
  assert.match(res.stdout, /INVALID RECORD FILE/);
  assert.match(res.stdout, /1 finding\(s\)/);
});

test('missing base ref, unresolvable default branch, and a non-git store are usage errors (exit 2)', async () => {
  const { project } = await billingRepo();
  assert.throws(() => runCheck({ store: project, base: 'no-such-branch' }), CheckUsageError);
  assert.throws(() => runCheck({ store: project }), /cannot determine the default branch/);

  const missing = await cli(['check', '--store', project, '--base', 'no-such-branch']);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /base ref "no-such-branch" does not resolve/);

  const plain = await newStore(false);
  const notRepo = await cli(['check', '--store', plain]);
  assert.equal(notRepo.code, 2);
  assert.match(notRepo.stderr, /not inside a git working tree/);

  const usage = await cli(['check', '--store', plain, '--no-such-flag']);
  assert.equal(usage.code, 2);
});

// --- 7. --all ---

test('--all reports pre-existing pairs without git (CLI, exit 1)', async () => {
  const project = await newStore(false);
  addClaim(project, 'decision', 'Invoice rounding follows banker convention');
  addClaim(project, 'decision', 'Invoice rounding banker exceptions for refunds');
  const res = await cli(['check', '--all', '--store', join(project, '.memspec')]);
  assert.equal(res.code, 1);
  assert.match(res.stdout, /auditing every active claim/);
  assert.match(res.stdout, /memspec check: 2 record\(s\) checked, 1 finding\(s\)/);
});

// --- 9. --json shape ---

test('--json emits the documented report shape; exit 1 on findings, 0 after distinct_from', async () => {
  const { project, fact, decision } = await billingRepo();
  const res = await cli(['check', '--store', project, '--base', 'main', '--json']);
  assert.equal(res.code, 1);
  const report = JSON.parse(res.stdout);
  assert.deepEqual(Object.keys(report).sort(), ['base', 'checked', 'invalid', 'merge_base', 'mode', 'ok', 'pairs', 'skipped_unchanged_content', 'store'].sort());
  assert.equal(report.ok, false);
  assert.equal(report.mode, 'git');
  assert.equal(report.base, 'main');
  assert.match(report.merge_base, /^[0-9a-f]{40}$/);
  assert.equal(report.store, '.memspec');
  assert.deepEqual(report.checked, [decision.id]);
  assert.deepEqual(report.invalid, []);
  const [pair] = report.pairs;
  assert.deepEqual(Object.keys(pair).sort(), ['a', 'b', 'signals', 'status']);
  assert.deepEqual(Object.keys(pair.a).sort(), ['file', 'id', 'title', 'type']);
  assert.deepEqual(Object.keys(pair.signals).sort(), ['overlap', 'path_mention', 'shared_anchor', 'title_terms']);
  assert.equal(pair.b.id, fact.id);
  assert.equal(pair.status, 'unacknowledged');

  await runCli(['relate', '--cwd', project, '--from', decision.id, '--to', fact.id, '--type', 'distinct_from']);
  const after = await cli(['check', '--store', project, '--base', 'main', '--json']);
  assert.equal(after.code, 0, after.stdout + after.stderr);
  assert.equal(JSON.parse(after.stdout).ok, true);
});

test('check writes nothing to the store', async () => {
  const { project } = await billingRepo();
  runCheck({ store: project, base: 'main' });
  runCheck({ store: project, all: true });
  assert.equal(git(project, 'status', '--porcelain', '--untracked-files=all'), '');
});

test('unrelate distinct_from removes the acknowledgement and logs the removal', async () => {
  const { project, decision, fact } = await billingRepo();
  runRelate({ cwd: project, from: decision.id, to: fact.id, type: 'distinct_from' });
  assert.equal(runCheck({ store: project, base: 'main' }).ok, true);
  runUnrelate({ cwd: project, from: decision.id, to: fact.id, type: 'distinct_from', reason: 'they do overlap', source: 'test' });
  assert.equal(runCheck({ store: project, base: 'main' }).ok, false);
  const rec = new MemspecStore(project).findById(decision.id)!;
  assert.equal(rec.distinct_from, undefined);
  const log = rec.ext?.edge_removals as Array<{ type: string; to: string }>;
  assert.equal(log.length, 1);
  assert.equal(log[0].type, 'distinct_from');
  assert.equal(log[0].to, fact.id);
});
