import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runAnchor } from '../src/commands/anchor.js';
import { runRemember } from '../src/commands/remember.js';
import { runVerify } from '../src/commands/verify.js';
import { repoIdentityRoot } from '../src/lib/anchors.js';
import { makeTempProject, runCli } from './helpers.js';

/**
 * An anchor written from a linked git worktree records the MAIN repository's
 * name, not the worktree folder's: `<root>/app.worktrees/feat/src/a.ts` is
 * `{repo: app, file: src/a.ts}`, and still verifies after the worktree is
 * removed. Real temporary repositories, no mocks.
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

async function fixture(): Promise<{ root: string; proj: string; app: string; worktree: string }> {
  const root = realpathSync(await makeTempProject());
  const proj = join(root, 'proj');
  mkdirSync(proj);
  await runCli(['init', '--cwd', proj, '--no-interactive', '--no-install-hooks']);

  const app = join(root, 'app');
  mkdirSync(join(app, 'src'), { recursive: true });
  writeFileSync(join(app, 'src', 'a.ts'), 'export const a = 1;\n');
  git(app, 'init', '-q', '-b', 'main');
  git(app, 'add', '.');
  git(app, 'commit', '-q', '-m', 'init');

  const worktree = join(root, 'app.worktrees', 'feat');
  git(app, 'worktree', 'add', '-q', '-b', 'feat', worktree);
  return { root, proj, app, worktree };
}

test('repoIdentityRoot maps a linked worktree to its main checkout and leaves everything else alone', async () => {
  const { root, app, worktree } = await fixture();
  assert.equal(realpathSync(repoIdentityRoot(worktree)), app);
  assert.equal(repoIdentityRoot(app), app);
  assert.equal(repoIdentityRoot(root), root, 'not a repository');
});

test('remember with an absolute anchor inside a worktree records the main repo and survives worktree removal', async () => {
  const { proj, app, worktree } = await fixture();
  const result = runRemember('fact', 'Module a exports the constant one', {
    cwd: proj,
    body: 'a = 1',
    source: 'agent-a',
    anchors: [join(worktree, 'src', 'a.ts')],
  });
  assert.deepEqual(result.anchorWarnings, [], 'the main checkout resolves from this store: no warning');
  assert.equal(result.anchors.length, 1);
  assert.equal(result.anchors[0].repo, 'app', 'the main repository name, not the worktree folder');
  assert.equal(result.anchors[0].file, 'src/a.ts');

  git(app, 'worktree', 'remove', worktree);
  const verified = runVerify(result.id, { cwd: proj });
  assert.equal(verified.status, 'verified', 'resolved against the main checkout after the worktree is gone');
});

test('anchor and repo-qualified paths through a sibling worktree record the main repo too', async () => {
  const { root, proj, app } = await fixture();
  const sibling = join(root, 'app-hotfix');
  git(app, 'worktree', 'add', '-q', '-b', 'hotfix', sibling);

  const rec = runRemember('fact', 'Module a exports a single constant', { cwd: proj, body: 'a', source: 'agent-a' });
  const anchored = runAnchor(rec.id, [join(sibling, 'src', 'a.ts')], { cwd: proj });
  assert.equal(anchored.anchors[0].repo, 'app');

  const qualified = runRemember('fact', 'The a module is plain TypeScript', {
    cwd: proj, body: 'ts', source: 'agent-a', anchors: ['app-hotfix/src/a.ts'],
  });
  assert.equal(qualified.anchors[0].repo, 'app');
  assert.equal(qualified.anchors[0].file, 'src/a.ts');
  assert.deepEqual(qualified.anchorWarnings, []);
});
