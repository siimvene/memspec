import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempProject, REPO_ROOT, runCli } from './helpers.js';
import { McpSession } from './mcp-session.js';
import { formatCoverageLine, searchPayload } from '../src/commands/search.js';
import { buildStatusReport, runStatus } from '../src/commands/status.js';
import { runRemember } from '../src/commands/remember.js';
import { runContext } from '../src/commands/context.js';
import { runVerify } from '../src/commands/verify.js';
import { runReconcile } from '../src/commands/reconcile.js';
import { resetDriftCache } from '../src/lib/drift.js';
import { expireGitStateCache, resetGitStateCache } from '../src/lib/git-state.js';
import { MemspecStore } from '../src/lib/store.js';

/**
 * Stale-read signals (post-0.11, batch 2): make it visible when what a session
 * reads is older than what the team already has.
 *
 *   4. A store layer read from a git checkout that is off its default branch,
 *      or behind origin's default branch (local refs only, as of the last
 *      fetch), is reported as `layers_stale` — search/MCP payload, the text
 *      Coverage block, and status.
 *   5. Read-path anchor drift compares the recorded blob to the anchored
 *      repo's remote default branch (`origin/main`), not to whatever branch the
 *      working tree happens to be on; each drift entry says what it compared
 *      against (`compared_to`).
 *
 * Origin: the kvart team-context checkout sat on a merged September branch,
 * 46 commits behind main, for a month; every session read month-old team
 * records with no warning. And anchors written on main read as drifted while
 * the code repo's checkout was on a feature branch.
 */

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'init.defaultBranch=main', ...args],
    { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
}

function commitAll(cwd: string, msg: string, paths: string[] = ['.']): string {
  git(cwd, 'add', '--', ...paths);
  git(cwd, 'commit', '-qm', msg);
  return git(cwd, 'rev-parse', 'HEAD');
}

/** Point a fake `origin/main` (and `origin/HEAD`) at `sha` — local refs only, no remote needed. */
function setOrigin(cwd: string, sha: string, branch = 'main', withHead = true): void {
  git(cwd, 'update-ref', `refs/remotes/origin/${branch}`, sha);
  if (withHead) git(cwd, 'symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${branch}`);
}

function layerDecl(entries: Array<{ name: string; path: string; priority: number; writable: boolean }>): string {
  return 'stores:\n' + entries.map((e) => `  - name: ${e.name}\n    path: ${e.path}\n    priority: ${e.priority}\n    writable: ${e.writable}\n`).join('');
}

function resetCaches(): void {
  resetGitStateCache();
  resetDriftCache();
}

/**
 * A personal store layered over a read-only team store whose `.memspec` lives
 * inside a git checkout (`team`). The checkout has one commit on `main`, and
 * `origin/main` + `origin/HEAD` point at it.
 */
async function teamCheckoutFixture() {
  const personal = await makeTempProject();
  const team = await makeTempProject();
  git(team, 'init', '-q');
  await runCli(['init', '--cwd', personal, '--no-interactive', '--no-install-hooks']);
  await runCli(['init', '--cwd', team, '--no-interactive', '--no-install-hooks']);
  runRemember('fact', 'Team deploy window policy', { cwd: team, body: 'Deploys happen Tuesdays.', source: 'team:eval' });
  const first = commitAll(team, 'team store');
  setOrigin(team, first);
  const personalMemspec = join(personal, '.memspec');
  const teamMemspec = join(team, '.memspec');
  writeFileSync(join(personalMemspec, 'config.yaml'), layerDecl([
    { name: 'personal', path: personalMemspec, priority: 0, writable: true },
    { name: 'team', path: teamMemspec, priority: 10, writable: false },
  ]));
  resetCaches();
  return { personal, team, personalMemspec, teamMemspec, first };
}

/** Advance origin/main by one commit the local checkout has "fetched" but not merged. */
function advanceOrigin(team: string): string {
  writeFileSync(join(team, 'NEWS.md'), `upstream change ${Math.random()}\n`);
  const next = commitAll(team, 'upstream change', ['NEWS.md']);
  setOrigin(team, next);
  return next;
}

// --- 4. Layer freshness ------------------------------------------------------

test('freshness: a layer checkout on its default branch and up to date is not flagged', async () => {
  const fx = await teamCheckoutFixture();
  const payload = searchPayload('deploy window', { cwd: fx.personal });
  assert.equal(payload.count, 1, 'team record visible');
  assert.equal(payload.layers_stale, undefined);
  assert.doesNotMatch(formatCoverageLine(payload), /Warning:/);
  const { report } = buildStatusReport({ cwd: fx.personal });
  assert.deepEqual(report.layers_stale, []);
  assert.doesNotMatch(runStatus({ cwd: fx.personal }), /## Layers stale/);
});

test('freshness: a layer checkout parked on a merged branch, behind origin/main, is flagged in search, text, status and status JSON', async () => {
  const fx = await teamCheckoutFixture();
  git(fx.team, 'checkout', '-q', '-b', 'sept-feature');
  git(fx.team, 'checkout', '-q', 'main');
  advanceOrigin(fx.team);
  advanceOrigin(fx.team);
  git(fx.team, 'checkout', '-q', 'sept-feature');
  resetCaches();

  const expected = [{ name: 'team', path: fx.teamMemspec, branch: 'sept-feature', default_branch: 'origin/main', behind: 2 }];
  const payload = searchPayload('deploy window', { cwd: fx.personal });
  assert.deepEqual(payload.layers_stale, expected);
  const text = formatCoverageLine(payload);
  assert.match(text, /^Coverage: ok/);
  assert.match(
    text,
    /Warning: store layer 'team' reads branch 'sept-feature', 2 commit\(s\) behind origin\/main as of the last fetch; its records may be outdated/,
  );

  const { report } = buildStatusReport({ cwd: fx.personal });
  assert.deepEqual(report.layers_stale, expected);
  const statusText = runStatus({ cwd: fx.personal });
  assert.match(statusText, /## Layers stale\n- 'team' reads branch 'sept-feature', 2 commit\(s\) behind origin\/main/);

  // CLI --json carries the same field.
  const cli = JSON.parse((await runCli(['search', 'deploy window', '--cwd', fx.personal, '--json'])).stdout) as { layers_stale: unknown };
  assert.deepEqual(cli.layers_stale, expected);
});

test('freshness: on the default branch but behind origin is flagged; off-branch with zero behind is flagged too', async () => {
  const fx = await teamCheckoutFixture();
  advanceOrigin(fx.team);
  git(fx.team, 'reset', '-q', '--hard', fx.first); // local main never pulled
  resetCaches();
  assert.deepEqual(searchPayload('deploy window', { cwd: fx.personal }).layers_stale, [
    { name: 'team', path: fx.teamMemspec, branch: 'main', default_branch: 'origin/main', behind: 1 },
  ]);

  git(fx.team, 'merge', '-q', '--ff-only', 'origin/main');
  git(fx.team, 'checkout', '-q', '-b', 'side');
  resetCaches();
  assert.deepEqual(searchPayload('deploy window', { cwd: fx.personal }).layers_stale, [
    { name: 'team', path: fx.teamMemspec, branch: 'side', default_branch: 'origin/main', behind: 0 },
  ]);
});

test('freshness: detached HEAD reports the short sha as the branch', async () => {
  const fx = await teamCheckoutFixture();
  git(fx.team, 'checkout', '-q', '--detach', 'HEAD');
  resetCaches();
  const short = git(fx.team, 'rev-parse', '--short', 'HEAD');
  assert.deepEqual(searchPayload('deploy window', { cwd: fx.personal }).layers_stale, [
    { name: 'team', path: fx.teamMemspec, branch: short, default_branch: 'origin/main', behind: 0 },
  ]);
});

test('freshness: without origin/HEAD the default branch falls back to origin/main, then origin/master; none at all skips silently', async () => {
  const fx = await teamCheckoutFixture();
  git(fx.team, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
  git(fx.team, 'checkout', '-q', '-b', 'topic');
  resetCaches();
  assert.equal(searchPayload('deploy window', { cwd: fx.personal }).layers_stale?.[0]?.default_branch, 'origin/main');

  git(fx.team, 'update-ref', '-d', 'refs/remotes/origin/main');
  git(fx.team, 'branch', '-q', '-m', 'main', 'master');
  setOrigin(fx.team, fx.first, 'master', false);
  resetCaches();
  const viaMaster = searchPayload('deploy window', { cwd: fx.personal }).layers_stale;
  assert.equal(viaMaster?.[0]?.default_branch, 'origin/master');
  assert.equal(viaMaster?.[0]?.branch, 'topic');

  git(fx.team, 'update-ref', '-d', 'refs/remotes/origin/master');
  resetCaches();
  const none = searchPayload('deploy window', { cwd: fx.personal });
  assert.equal(none.layers_stale, undefined, 'no remote default ref: nothing to compare against, no warning');
  assert.equal(none.count, 1);
});

test('freshness: a layer outside any git checkout is never flagged', async () => {
  const personal = await makeTempProject();
  const team = await makeTempProject();
  await runCli(['init', '--cwd', personal, '--no-interactive', '--no-install-hooks']);
  await runCli(['init', '--cwd', team, '--no-interactive', '--no-install-hooks']);
  writeFileSync(join(personal, '.memspec', 'config.yaml'), layerDecl([
    { name: 'personal', path: join(personal, '.memspec'), priority: 0, writable: true },
    { name: 'team', path: join(team, '.memspec'), priority: 10, writable: false },
  ]));
  resetCaches();
  assert.equal(searchPayload('anything', { cwd: personal }).layers_stale, undefined);
  assert.deepEqual(buildStatusReport({ cwd: personal }).report.layers_stale, []);
});

test('freshness: a checkout switch is noticed after the cache window; the cache spares repeat git calls within it', async () => {
  const fx = await teamCheckoutFixture();
  assert.equal(searchPayload('deploy window', { cwd: fx.personal }).layers_stale, undefined);
  git(fx.team, 'checkout', '-q', '-b', 'moved-away');
  // Within the TTL the cached verdict stands (no git spawn per query) ...
  assert.equal(searchPayload('deploy window', { cwd: fx.personal }).layers_stale, undefined);
  // ... and once the window passes, the switch shows up.
  expireGitStateCache();
  assert.equal(searchPayload('deploy window', { cwd: fx.personal }).layers_stale?.[0]?.branch, 'moved-away');
});

test('freshness: memspec_search over MCP carries layers_stale in structuredContent and the warning in text', async () => {
  const fx = await teamCheckoutFixture();
  advanceOrigin(fx.team);
  git(fx.team, 'reset', '-q', '--hard', fx.first);
  const session = new McpSession([join(REPO_ROOT, 'src/mcp.ts'), '--cwd', fx.personal]);
  try {
    await session.request('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'stale-reads', version: '0.0.0' },
    });
    session.notify('notifications/initialized', {});
    const res = await session.request('tools/call', { name: 'memspec_search', arguments: { query: 'deploy window' } });
    const r = res.result as { content: Array<{ text: string }>; structuredContent: { layers_stale?: unknown } };
    assert.deepEqual(r.structuredContent.layers_stale, [
      { name: 'team', path: fx.teamMemspec, branch: 'main', default_branch: 'origin/main', behind: 1 },
    ]);
    assert.match(r.content[0].text, /Warning: store layer 'team' reads branch 'main', 1 commit\(s\) behind origin\/main/);
  } finally {
    await session.close();
  }
});

// --- 5. Anchor drift against the default branch -----------------------------

/**
 * A code repo that is also the store's project root. `engine.ts` holds `v1`
 * on main; origin/main points at that commit. The record is anchored to it.
 */
async function anchoredRepoFixture(opts: { origin?: boolean } = {}) {
  const project = await makeTempProject();
  git(project, 'init', '-q');
  writeFileSync(join(project, '.gitignore'), '.memspec/\nlocal.env\n');
  writeFileSync(join(project, 'engine.ts'), 'export const e = 1;\n');
  const base = commitAll(project, 'engine v1');
  if (opts.origin !== false) setOrigin(project, base);
  await runCli(['init', '--cwd', project, '--no-interactive', '--no-install-hooks']);
  const rec = runRemember('fact', 'Engine constant is one', {
    cwd: project, body: 'engine exports e = 1', source: 'test', anchors: [join(project, 'engine.ts')],
  });
  resetCaches();
  return { project, base, id: rec.id };
}

function hit(project: string, query = 'engine constant') {
  const payload = searchPayload(query, { cwd: project });
  assert.equal(payload.count, 1);
  return payload.results[0];
}

test('drift: a feature-branch edit in the working tree does NOT drift a record anchored to main', async () => {
  const fx = await anchoredRepoFixture();
  git(fx.project, 'checkout', '-q', '-b', 'feature');
  writeFileSync(join(fx.project, 'engine.ts'), 'export const e = 2; // feature work\n');
  commitAll(fx.project, 'feature edit', ['engine.ts']);
  resetCaches();

  const row = hit(fx.project);
  assert.equal(row.drifted, false);
  assert.equal(row.drift, undefined);
  assert.equal(buildStatusReport({ cwd: fx.project }).report.drifted, 0, 'status drift count compares to main too');
  assert.doesNotMatch(runContext({ cwd: fx.project }), /anchor drift/, 'boot attention list compares to main too');
});

test('drift: a change that landed on origin/main drifts the record even while the checkout still has the old file', async () => {
  const fx = await anchoredRepoFixture();
  writeFileSync(join(fx.project, 'engine.ts'), 'export const e = 3; // upstream\n');
  const upstream = commitAll(fx.project, 'upstream edit', ['engine.ts']);
  setOrigin(fx.project, upstream);
  git(fx.project, 'reset', '-q', '--hard', fx.base); // local checkout never pulled
  resetCaches();

  const row = hit(fx.project);
  assert.equal(row.drifted, true);
  assert.deepEqual(row.drift, [{ file: 'engine.ts', status: 'changed', compared_to: 'origin/main' }]);
  assert.equal(buildStatusReport({ cwd: fx.project }).report.drifted, 1);
  assert.match(runContext({ cwd: fx.project }), /anchor drift: engine\.ts/);
});

test('drift: a file deleted on origin/main reads as missing against that ref', async () => {
  const fx = await anchoredRepoFixture();
  git(fx.project, 'rm', '-q', 'engine.ts');
  git(fx.project, 'commit', '-qm', 'drop engine');
  setOrigin(fx.project, git(fx.project, 'rev-parse', 'HEAD'));
  git(fx.project, 'reset', '-q', '--hard', fx.base);
  resetCaches();
  assert.deepEqual(hit(fx.project).drift, [{ file: 'engine.ts', status: 'missing', compared_to: 'origin/main' }]);
});

test('drift: a repo without a remote default ref falls back to the working tree and says so', async () => {
  const fx = await anchoredRepoFixture({ origin: false });
  writeFileSync(join(fx.project, 'engine.ts'), 'export const e = 9;\n');
  resetCaches();
  assert.deepEqual(hit(fx.project).drift, [{ file: 'engine.ts', status: 'changed', compared_to: 'worktree' }]);
});

test('drift: a gitignored anchored file can never be on the default branch, so it is compared in the working tree', async () => {
  const fx = await anchoredRepoFixture();
  writeFileSync(join(fx.project, 'local.env'), 'A=1\n');
  const rec = runRemember('fact', 'Local env sets flag A', {
    cwd: fx.project, body: 'local env A one', source: 'test', anchors: [join(fx.project, 'local.env')],
  });
  resetCaches();
  const clean = hit(fx.project, 'local env flag');
  assert.equal(clean.id, rec.id);
  assert.equal(clean.drifted, false, 'ignored file unchanged in the working tree is not drift');
  writeFileSync(join(fx.project, 'local.env'), 'A=2\n');
  resetCaches();
  assert.deepEqual(hit(fx.project, 'local env flag').drift, [{ file: 'local.env', status: 'changed', compared_to: 'worktree' }]);
});

test('drift: memspec_get over MCP names the ref each drift entry was compared to', async () => {
  const fx = await anchoredRepoFixture();
  writeFileSync(join(fx.project, 'engine.ts'), 'export const e = 4;\n');
  setOrigin(fx.project, commitAll(fx.project, 'upstream', ['engine.ts']));
  git(fx.project, 'reset', '-q', '--hard', fx.base);
  const session = new McpSession([join(REPO_ROOT, 'src/mcp.ts'), '--cwd', fx.project]);
  try {
    await session.request('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'stale-reads', version: '0.0.0' },
    });
    session.notify('notifications/initialized', {});
    const get = await session.request('tools/call', { name: 'memspec_get', arguments: { id: fx.id } });
    const parsed = JSON.parse((get.result as { content: Array<{ text: string }> }).content[0].text) as { drifted?: boolean; drift?: unknown };
    assert.equal(parsed.drifted, true);
    assert.deepEqual(parsed.drift, [{ file: 'engine.ts', status: 'changed', compared_to: 'origin/main' }]);
  } finally {
    await session.close();
  }
});

test('drift: verify and reconcile keep working-tree semantics (unchanged contract)', async () => {
  const fx = await anchoredRepoFixture();
  git(fx.project, 'checkout', '-q', '-b', 'feature');
  writeFileSync(join(fx.project, 'engine.ts'), 'export const e = 5;\n');
  resetCaches();
  // Read path: matches main, not drifted.
  assert.equal(hit(fx.project).drifted, false);
  // verify hashes the working tree, exactly as before.
  const v = runVerify(fx.id, { cwd: fx.project, source: 'test' });
  assert.equal(v.status, 'needs_review');
  // reconcile answers "what did this checkout change" — the working tree.
  const rc = runReconcile({ cwd: fx.project });
  assert.deepEqual(rc.candidates.map((c) => c.changed_files), [[{ file: 'engine.ts', status: 'changed' }]]);
});

test('drift: memoized per (repo, ref sha, path) — moving origin/main is seen without a cache reset of the blob table', async () => {
  const fx = await anchoredRepoFixture();
  assert.equal(hit(fx.project).drifted, false);
  writeFileSync(join(fx.project, 'engine.ts'), 'export const e = 6;\n');
  const next = commitAll(fx.project, 'upstream', ['engine.ts']);
  setOrigin(fx.project, next);
  git(fx.project, 'reset', '-q', '--hard', fx.base);
  expireGitStateCache(); // ref TTL window passes; the blob memo survives but is keyed by ref sha, so no stale hit
  assert.equal(hit(fx.project).drifted, true);
});

test('drift/freshness: git failures never throw — a corrupt repo degrades to the working-tree comparison', async () => {
  const fx = await anchoredRepoFixture();
  // Break the repo's object store under git's feet: refs still resolve as files but git calls fail.
  rmSync(join(fx.project, '.git', 'objects'), { recursive: true, force: true });
  mkdirSync(join(fx.project, '.git', 'objects'));
  resetCaches();
  const row = hit(fx.project);
  assert.equal(row.drifted, false);
  assert.equal(row.drift, undefined);
  const store = new MemspecStore(join(fx.project, '.memspec'));
  assert.ok(store.exists);
});
