import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import matter from 'gray-matter';
import { makeTempProject, runCli } from './helpers.js';

const execFileAsync = promisify(execFile);

async function gitInTarget(target: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, {
    cwd: target,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@test',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@test',
    },
  });
}

async function anchorFile(target: string, id: string, file: string): Promise<void> {
  await runCli(['anchor', id, file, '--cwd', target]);
}

async function factData(target: string, id: string): Promise<Record<string, unknown>> {
  return matter(await readFile(join(target, '.memspec', 'memory', 'facts', `${id}.md`), 'utf8')).data as Record<string, unknown>;
}

async function newFactId(target: string, title: string): Promise<string> {
  await runCli(['remember', 'fact', title, '--cwd', target, '--body', 'Body', '--source', 'test']);
  const entries = await readdir(join(target, '.memspec', 'memory', 'facts'));
  return entries[entries.length - 1].replace(/\.md$/, '');
}

async function makeGitProject(): Promise<string> {
  const target = await makeTempProject();
  await gitInTarget(target, ['init', '--quiet']);
  return target;
}

async function addAnchoredFact(target: string, title: string, file: string): Promise<string> {
  await runCli(['remember', 'fact', title, '--cwd', target, '--body', 'Body', '--source', 'test']);
  const factsDir = join(target, '.memspec', 'memory', 'facts');
  const entries = await readdir(factsDir);
  const id = entries[entries.length - 1].replace(/\.md$/, '');
  await runCli(['anchor', id, file, '--cwd', target]);
  return id;
}

test('reconcile is clean when anchored files are unchanged', async () => {
  const target = await makeGitProject();
  await runCli(['init', '--cwd', target]);
  await writeFile(join(target, 'auth.py'), 'argon2id\n');
  await gitInTarget(target, ['add', '.']);
  await gitInTarget(target, ['commit', '--quiet', '-m', 'initial']);
  await addAnchoredFact(target, 'Auth backend', 'auth.py');

  const result = await runCli(['reconcile', '--cwd', target]);
  assert.match(result.stdout, /Reconcile clean: 1 anchored/);

  // Checkpoint written for the next run
  await access(join(target, '.memspec', '.reconcile.json'));
});

test('reconcile flags memories whose anchored files changed', async () => {
  const target = await makeGitProject();
  await runCli(['init', '--cwd', target]);
  await writeFile(join(target, 'auth.py'), 'mockup\n');
  await writeFile(join(target, 'other.py'), 'unrelated\n');
  await gitInTarget(target, ['add', '.']);
  await gitInTarget(target, ['commit', '--quiet', '-m', 'initial']);

  const anchoredId = await addAnchoredFact(target, 'Auth is a mockup', 'auth.py');
  await addAnchoredFact(target, 'Other module', 'other.py');

  // The auth implementation ships
  await writeFile(join(target, 'auth.py'), 'real argon2id implementation\n');
  await gitInTarget(target, ['add', 'auth.py']);
  await gitInTarget(target, ['commit', '--quiet', '-m', 'ship real auth']);

  await assert.rejects(
    () => runCli(['reconcile', '--cwd', target]),
    (error: Error & { stdout?: string }) => {
      assert.match(error.stdout ?? '', /1 memory\(ies\) need reconciliation \(of 2 anchored\)/);
      assert.match(error.stdout ?? '', new RegExp(anchoredId));
      assert.match(error.stdout ?? '', /changed: auth\.py/);
      assert.doesNotMatch(error.stdout ?? '', /other\.py/);
      return true;
    },
  );
});

test('reconcile detects uncommitted changes too', async () => {
  const target = await makeGitProject();
  await runCli(['init', '--cwd', target]);
  await writeFile(join(target, 'config.ts'), 'v1\n');
  await gitInTarget(target, ['add', '.']);
  await gitInTarget(target, ['commit', '--quiet', '-m', 'initial']);
  await addAnchoredFact(target, 'Config shape', 'config.ts');

  await writeFile(join(target, 'config.ts'), 'v2 uncommitted\n');

  await assert.rejects(
    () => runCli(['reconcile', '--cwd', target]),
    (error: Error & { stdout?: string }) => {
      assert.match(error.stdout ?? '', /changed: config\.ts/);
      return true;
    },
  );
});

test('reconcile reports renames with the new path', async () => {
  const target = await makeGitProject();
  await runCli(['init', '--cwd', target]);
  await writeFile(join(target, 'old-name.py'), 'stable content that survives the rename\n');
  await gitInTarget(target, ['add', '.']);
  await gitInTarget(target, ['commit', '--quiet', '-m', 'initial']);
  await addAnchoredFact(target, 'Renamed module', 'old-name.py');

  await rename(join(target, 'old-name.py'), join(target, 'new-name.py'));
  await gitInTarget(target, ['add', '-A']);
  await gitInTarget(target, ['commit', '--quiet', '-m', 'rename']);

  await assert.rejects(
    () => runCli(['reconcile', '--cwd', target, '--since', 'HEAD~1']),
    (error: Error & { stdout?: string }) => {
      assert.match(error.stdout ?? '', /renamed: old-name\.py → new-name\.py/);
      return true;
    },
  );
});

test('reconcile --json returns structured candidates', async () => {
  const target = await makeGitProject();
  await runCli(['init', '--cwd', target]);
  await writeFile(join(target, 'api.ts'), 'v1\n');
  await gitInTarget(target, ['add', '.']);
  await gitInTarget(target, ['commit', '--quiet', '-m', 'initial']);
  const id = await addAnchoredFact(target, 'API shape', 'api.ts');

  await writeFile(join(target, 'api.ts'), 'v2\n');

  await assert.rejects(
    () => runCli(['reconcile', '--cwd', target, '--json']),
    (error: Error & { stdout?: string }) => {
      const parsed = JSON.parse(error.stdout ?? '{}');
      assert.equal(parsed.candidates.length, 1);
      assert.equal(parsed.candidates[0].memory_id, id);
      assert.deepEqual(parsed.candidates[0].changed_files, [{ file: 'api.ts', status: 'changed' }]);
      assert.ok(parsed.head, 'head SHA should be recorded');
      return true;
    },
  );
});

// --- per-anchor-repo rename detection (home-store shape) --------------------

test('reconcile detects renames in a nested repo when the store root is not a git repo', async () => {
  // Mirrors a home-rooted store: projectRoot (the store's parent) is NOT a git
  // repo, but an anchor points into a repo nested under it. Rename detection
  // must run inside THAT repo, not against the non-repo project root.
  const target = await makeTempProject(); // deliberately no git init at the root
  await runCli(['init', '--cwd', target]);

  const sub = join(target, 'sub');
  await mkdir(sub, { recursive: true });
  await gitInTarget(sub, ['init', '--quiet']);
  await writeFile(join(sub, 'old.py'), 'stable content that survives the rename\n');
  await gitInTarget(sub, ['add', '.']);
  await gitInTarget(sub, ['commit', '--quiet', '-m', 'initial']);

  const id = await newFactId(target, 'Nested module');
  await anchorFile(target, id, 'sub/old.py');

  await rename(join(sub, 'old.py'), join(sub, 'new.py'));
  await gitInTarget(sub, ['add', '-A']);
  await gitInTarget(sub, ['commit', '--quiet', '-m', 'rename']);

  await assert.rejects(
    () => runCli(['reconcile', '--cwd', target]),
    (error: Error & { stdout?: string }) => {
      assert.match(error.stdout ?? '', /renamed: sub\/old\.py → sub\/new\.py/);
      return true;
    },
  );
});

test('reconcile --repair-renames re-points an identical-content move (dry-run then apply)', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  const sub = join(target, 'sub');
  await mkdir(sub, { recursive: true });
  await gitInTarget(sub, ['init', '--quiet']);
  await writeFile(join(sub, 'old.py'), 'identical bytes\n');
  await gitInTarget(sub, ['add', '.']);
  await gitInTarget(sub, ['commit', '--quiet', '-m', 'initial']);

  const id = await newFactId(target, 'Movable module');
  await anchorFile(target, id, 'sub/old.py');

  await rename(join(sub, 'old.py'), join(sub, 'new.py'));
  await gitInTarget(sub, ['add', '-A']);
  await gitInTarget(sub, ['commit', '--quiet', '-m', 'rename']);

  // Dry-run: lists the re-point, writes nothing.
  await assert.rejects(
    () => runCli(['reconcile', '--cwd', target, '--repair-renames']),
    (error: Error & { stdout?: string }) => {
      assert.match(error.stdout ?? '', /Rename repair \(DRY-RUN\)/);
      assert.match(error.stdout ?? '', new RegExp(`${id}: sub/old\\.py → sub/new\\.py`));
      return true;
    },
  );
  const dryAnchors = (await factData(target, id)).anchors as Array<{ file: string }>;
  assert.equal(dryAnchors[0].file, 'sub/old.py', 'dry-run must not rewrite the anchor');

  // Apply: the anchor is re-pointed to the new path, sha preserved.
  await assert.rejects(
    () => runCli(['reconcile', '--cwd', target, '--repair-renames', '--apply']),
    (error: Error & { stdout?: string }) => {
      assert.match(error.stdout ?? '', /Rename repair \(APPLIED\)/);
      return true;
    },
  );
  const anchors = (await factData(target, id)).anchors as Array<{ file: string; sha: string }>;
  assert.equal(anchors[0].file, 'sub/new.py', 'anchor re-pointed to the moved file');

  // Re-pointed anchor now matches: a fresh reconcile is clean (exit 0).
  const clean = await runCli(['reconcile', '--cwd', target]);
  assert.match(clean.stdout, /Reconcile clean/);
});

test('reconcile --repair-renames leaves a content-changed move drifted', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  const sub = join(target, 'sub');
  await mkdir(sub, { recursive: true });
  await gitInTarget(sub, ['init', '--quiet']);
  await writeFile(join(sub, 'old.py'), 'original body line one\noriginal body line two\n');
  await gitInTarget(sub, ['add', '.']);
  await gitInTarget(sub, ['commit', '--quiet', '-m', 'initial']);

  const id = await newFactId(target, 'Changed module');
  await anchorFile(target, id, 'sub/old.py');

  // Move AND modify — git still sees a rename (>50% similar) but the content
  // differs, so the anchor must stay drifted, not be silently re-pointed.
  await rename(join(sub, 'old.py'), join(sub, 'new.py'));
  await writeFile(join(sub, 'new.py'), 'original body line one\nMODIFIED line two\n');
  await gitInTarget(sub, ['add', '-A']);
  await gitInTarget(sub, ['commit', '--quiet', '-m', 'rename+edit']);

  await assert.rejects(
    () => runCli(['reconcile', '--cwd', target, '--repair-renames', '--apply']),
    (error: Error & { stdout?: string }) => {
      assert.match(error.stdout ?? '', /no identical-content moves to re-point/);
      return true;
    },
  );
  const anchors = (await factData(target, id)).anchors as Array<{ file: string; sha: string }>;
  assert.equal(anchors[0].file, 'sub/old.py', 'content-changed move is not auto-repaired');
});

test('reconcile works without git history (drift scan only)', async () => {
  const target = await makeTempProject(); // no git init
  await runCli(['init', '--cwd', target]);
  await writeFile(join(target, 'lib.ts'), 'v1\n');
  await addAnchoredFact(target, 'No-git project', 'lib.ts');

  const clean = await runCli(['reconcile', '--cwd', target]);
  assert.match(clean.stdout, /Reconcile clean/);

  await writeFile(join(target, 'lib.ts'), 'v2\n');
  await assert.rejects(
    () => runCli(['reconcile', '--cwd', target]),
    (error: Error & { stdout?: string }) => {
      assert.match(error.stdout ?? '', /changed: lib\.ts/);
      return true;
    },
  );
});
