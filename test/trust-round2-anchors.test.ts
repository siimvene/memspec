import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runAnchor } from '../src/commands/anchor.js';
import { runRemember } from '../src/commands/remember.js';
import { runVerify } from '../src/commands/verify.js';
import { blobSha } from '../src/lib/anchors.js';
import { expireGitStateCache } from '../src/lib/git-state.js';
import { MemspecStore } from '../src/lib/store.js';
import { makeTempProject, runCli } from './helpers.js';

/**
 * Second review round, anchor findings: verify --reanchor never re-baselines
 * to a blob this checkout does not hold; `anchor` keeps the shas it moves in
 * ext.anchor_history; a linked worktree of the store's own repo anchors in the
 * repo-less project form. Real temporary repositories, no mocks.
 */

function git(cwd: string, ...args: string[]): string {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@test',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@test',
  };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[name];
  return execFileSync('git', args, { cwd, env, encoding: 'utf8' });
}

/** A git repo holding the store, with src/limits.ts committed and origin/main pointing at it. */
async function repoStore(): Promise<{ cwd: string; file: string }> {
  const cwd = realpathSync(await makeTempProject());
  mkdirSync(join(cwd, 'src'));
  const file = join(cwd, 'src', 'limits.ts');
  writeFileSync(file, 'export const MAX_UPLOAD_MB = 5;\n');
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-q', '-m', 'init');
  git(cwd, 'update-ref', 'refs/remotes/origin/main', 'main');
  await runCli(['init', '--cwd', cwd, '--no-interactive', '--no-install-hooks']);
  expireGitStateCache();
  return { cwd, file };
}

test('verify --reanchor: a file missing from this checkout is not re-baselined to the default branch blob', async () => {
  const { cwd, file } = await repoStore();
  const rec = runRemember('fact', 'Uploads are capped at 5 MB', { cwd, body: 'MAX_UPLOAD_MB', source: 'agent-a', anchors: ['src/limits.ts'] });
  const oldSha = rec.anchors[0].sha;
  // The file changes on origin/main, and this checkout deletes it.
  writeFileSync(file, '// moved\nexport const MAX_UPLOAD_MB = 5;\n');
  git(cwd, 'commit', '-q', '-am', 'edit');
  git(cwd, 'update-ref', 'refs/remotes/origin/main', 'main');
  rmSync(file);
  expireGitStateCache();

  const result = runVerify(rec.id, { cwd, reanchor: true, evidence: 'looked at it' });
  assert.equal(result.status, 'needs_review');
  assert.equal(result.anchors[0].worktree_missing, true);
  assert.match(result.message, /missing in this checkout \(changed on origin\/main\): src\/limits\.ts/);
  const after = new MemspecStore(cwd).findById(rec.id)!;
  assert.equal(after.anchors![0].sha, oldSha, 'anchor untouched');
  assert.equal(after.ext?.anchor_history, undefined);
});

test('verify --reanchor: an anchor matching origin/main holds (by design); a local-only edit is not re-baselined', async () => {
  const { cwd, file } = await repoStore();
  const rec = runRemember('fact', 'Uploads are capped at 5 MB', { cwd, body: 'MAX_UPLOAD_MB', source: 'agent-a', anchors: ['src/limits.ts'] });
  const sha = rec.anchors[0].sha;
  writeFileSync(file, '// local edit\nexport const MAX_UPLOAD_MB = 5;\n');
  expireGitStateCache();
  const result = runVerify(rec.id, { cwd, reanchor: true, evidence: 'checked' });
  assert.equal(result.status, 'verified');
  assert.equal(result.reanchored, undefined);
  assert.match(result.message, /matched origin\/main only \(this checkout's copy differs\)/);
  assert.equal(new MemspecStore(cwd).findById(rec.id)!.anchors![0].sha, sha, 'still the sha everyone on main reads');
});

test('anchor: moving an existing anchor or dropping one with replace is kept in ext.anchor_history', async () => {
  const { cwd, file } = await repoStore();
  writeFileSync(join(cwd, 'src', 'other.ts'), 'export const other = 1;\n');
  const rec = runRemember('fact', 'Uploads are capped at 5 MB', { cwd, body: 'MAX_UPLOAD_MB', source: 'agent-a', anchors: ['src/limits.ts', 'src/other.ts'] });
  const [limits, other] = rec.anchors;

  // Same blob: nothing to record.
  runAnchor(rec.id, ['src/limits.ts'], { cwd, source: 'agent-b', channel: 'mcp' });
  assert.equal(new MemspecStore(cwd).findById(rec.id)!.ext?.anchor_history, undefined);

  writeFileSync(file, '// refactor\nexport const MAX_UPLOAD_MB = 5;\n');
  runAnchor(rec.id, ['src/limits.ts'], { cwd, source: 'human:op', channel: 'mcp', replace: true });
  const history = new MemspecStore(cwd).findById(rec.id)!.ext?.anchor_history as Array<Record<string, unknown>>;
  assert.equal(history.length, 1);
  assert.equal(history[0].via, 'anchor');
  assert.equal(history[0].source, 'mcp:human:op', 'operator-pattern source downgraded over MCP');
  const moved = [...(history[0].anchors as Array<{ file: string }>)].sort((x, y) => x.file.localeCompare(y.file));
  assert.deepEqual(moved, [
    { file: 'src/limits.ts', previous_sha: limits.sha, sha: blobSha(file) },
    { file: 'src/other.ts', previous_sha: other.sha, sha: null },
  ]);
});

test('an absolute path in a linked worktree of the store\'s own repo anchors in the repo-less project form', async () => {
  const { cwd } = await repoStore();
  const rec = runRemember('fact', 'Uploads are capped at 5 MB', { cwd, body: 'MAX_UPLOAD_MB', source: 'agent-a', anchors: ['src/limits.ts'] });
  assert.equal(rec.anchors[0].repo, undefined);
  const worktree = join(cwd, '..', `${cwd.split('/').pop()}.worktrees`, 'feat');
  git(cwd, 'worktree', 'add', '-q', '-b', 'feat', worktree);
  writeFileSync(join(worktree, 'src', 'limits.ts'), '// feature\nexport const MAX_UPLOAD_MB = 5;\n');

  const result = runAnchor(rec.id, [join(worktree, 'src', 'limits.ts')], { cwd, source: 'agent-a' });
  assert.equal(result.anchors.length, 1, 'one anchor for the file, not a repo-qualified twin');
  assert.equal(result.anchors[0].repo, undefined);
  assert.equal(result.anchors[0].file, 'src/limits.ts');
  assert.equal(result.anchors[0].sha, blobSha(join(worktree, 'src', 'limits.ts')));
  assert.match(result.warnings.join('\n'), /anchored to an unmerged change/);
});
