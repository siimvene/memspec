import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';
import { makeTempProject, readText, runCli } from './helpers.js';

async function addFact(target: string, title: string): Promise<string> {
  await runCli(['add', 'fact', title, '--cwd', target, '--body', 'Body text', '--source', 'test']);
  const factsDir = join(target, '.memspec', 'memory', 'facts');
  const entries = await readdir(factsDir);
  return entries[entries.length - 1].replace(/\.md$/, '');
}

test('verify without anchors refreshes last_verified and decay clock', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  const id = await addFact(target, 'Plain fact');
  const factPath = join(target, '.memspec', 'memory', 'facts', `${id}.md`);

  const before = matter(await readText(factPath)).data;

  const result = await runCli(['verify', id, '--cwd', target, '--evidence', 'checked manually', '--source', 'tester']);
  assert.match(result.stdout, /Verified/);
  assert.match(result.stdout, /no code anchors/);

  const after = matter(await readText(factPath)).data;
  assert.ok(Date.parse(String(after.last_verified)) >= Date.parse(String(before.last_verified)));
  assert.ok(after.confidence > before.confidence);
  assert.ok(Date.parse(String(after.decay_after)) >= Date.parse(String(before.decay_after)));
  assert.equal(after.ext.last_verification.source, 'tester');
  assert.equal(after.ext.last_verification.evidence, 'checked manually');
});

test('verify rejects anchorless calls without evidence', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  const id = await addFact(target, 'Unwitnessed fact');
  const factPath = join(target, '.memspec', 'memory', 'facts', `${id}.md`);
  const before = await readText(factPath);

  await assert.rejects(
    () => runCli(['verify', id, '--cwd', target]),
    (error: Error & { stderr?: string }) => {
      assert.match(`${error.message}\n${error.stderr ?? ''}`, /requires --evidence/);
      return true;
    },
  );

  const after = await readText(factPath);
  assert.equal(after, before, 'rejected verify must not mutate the memory file');
});

test('verify with unchanged anchors passes', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  await writeFile(join(target, 'auth.py'), 'argon2id\n');
  const id = await addFact(target, 'Auth backend');
  await runCli(['anchor', id, 'auth.py', '--cwd', target]);

  const result = await runCli(['verify', id, '--cwd', target]);
  assert.match(result.stdout, /Verified/);
  assert.match(result.stdout, /1 anchor\(s\) unchanged/);
});

test('verify with changed anchor returns needs_review and leaves memory untouched', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  await writeFile(join(target, 'auth.py'), 'mockup\n');
  const id = await addFact(target, 'Auth is a mockup');
  await runCli(['anchor', id, 'auth.py', '--cwd', target]);

  const factPath = join(target, '.memspec', 'memory', 'facts', `${id}.md`);
  const before = await readText(factPath);

  await writeFile(join(target, 'auth.py'), 'real argon2id implementation\n');

  await assert.rejects(
    () => runCli(['verify', id, '--cwd', target]),
    (error: Error & { stdout?: string }) => {
      assert.match(error.stdout ?? '', /NEEDS REVIEW/);
      assert.match(error.stdout ?? '', /changed: auth\.py/);
      assert.match(error.stdout ?? '', /memspec correct/);
      return true;
    },
  );

  const after = await readText(factPath);
  assert.equal(after, before, 'needs_review must not mutate the memory file');
});

test('verify with missing anchored file returns needs_review', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  await writeFile(join(target, 'temp.ts'), 'soon gone\n');
  const id = await addFact(target, 'Depends on temp file');
  await runCli(['anchor', id, 'temp.ts', '--cwd', target]);

  const { rm } = await import('node:fs/promises');
  await rm(join(target, 'temp.ts'));

  await assert.rejects(
    () => runCli(['verify', id, '--cwd', target]),
    (error: Error & { stdout?: string }) => {
      assert.match(error.stdout ?? '', /missing: temp\.ts/);
      return true;
    },
  );
});

test('verify flags repo-qualified anchor for review when the repo is not checked out', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  const id = await addFact(target, 'Cross-repo fact');
  const factPath = join(target, '.memspec', 'memory', 'facts', `${id}.md`);

  const parsed = matter(await readText(factPath));
  parsed.data.ext = { code_anchors: [{ file: 'src/auth.ts', sha: 'deadbeef', repo: 'other-service' }] };
  await writeFile(factPath, matter.stringify(parsed.content, parsed.data));
  const before = await readText(factPath);

  await assert.rejects(
    () => runCli(['verify', id, '--cwd', target]),
    (error: Error & { stdout?: string }) => {
      assert.match(error.stdout ?? '', /NEEDS REVIEW/);
      assert.match(error.stdout ?? '', /anchor in repo other-service, fetch to verify/);
      return true;
    },
  );

  const after = await readText(factPath);
  assert.equal(after, before, 'repo_unavailable must not mutate the memory file');
});

test('verify resolves repo-qualified anchors against a sibling checkout', async () => {
  const base = await makeTempProject();
  const { mkdir } = await import('node:fs/promises');
  const project = join(base, 'project');
  const sibling = join(base, 'other-service');
  await mkdir(project, { recursive: true });
  await mkdir(sibling, { recursive: true });
  await writeFile(join(sibling, 'auth.ts'), 'argon2id\n');

  await runCli(['init', '--cwd', project]);
  const id = await addFact(project, 'Sibling repo fact');
  const factPath = join(project, '.memspec', 'memory', 'facts', `${id}.md`);

  const { blobSha } = await import('../src/lib/anchors.js');
  const sha = blobSha(join(sibling, 'auth.ts'));
  const parsed = matter(await readText(factPath));
  parsed.data.ext = { code_anchors: [{ file: 'auth.ts', sha, repo: 'other-service' }] };
  await writeFile(factPath, matter.stringify(parsed.content, parsed.data));

  const result = await runCli(['verify', id, '--cwd', project]);
  assert.match(result.stdout, /Verified/);
  assert.match(result.stdout, /1 anchor\(s\) unchanged/);
});

test('verify rejects non-active memories', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  const id = await addFact(target, 'Soon corrected');
  await runCli(['correct', id, '--cwd', target, '--reason', 'wrong']);

  await assert.rejects(
    () => runCli(['verify', id, '--cwd', target]),
    (error: Error & { stderr?: string }) => {
      assert.match(`${error.message}\n${error.stderr ?? ''}`, /only active memories/);
      return true;
    },
  );
});

test('verify keeps decay_after never untouched', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  await runCli([
    'add', 'decision', 'Durable decision', '--cwd', target,
    '--body', 'Locked in', '--source', 'test', '--decay-after', 'never',
  ]);
  const decisionsDir = join(target, '.memspec', 'memory', 'decisions');
  const [entry] = await readdir(decisionsDir);
  const id = entry.replace(/\.md$/, '');

  await runCli(['verify', id, '--cwd', target, '--evidence', 'still locked in']);

  const after = matter(await readText(join(decisionsDir, entry))).data;
  assert.equal(after.decay_after, 'never');
});
