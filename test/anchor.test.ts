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
  assert.equal(entries.length, 1);
  return entries[0].replace(/\.md$/, '');
}

test('anchor records blob SHAs for existing files', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  await writeFile(join(target, 'auth.py'), 'def login(): pass\n');
  const id = await addFact(target, 'Auth uses argon2id');

  const result = await runCli(['anchor', id, 'auth.py', '--cwd', target]);
  assert.match(result.stdout, /Anchored .* to 1 file\(s\)/);
  assert.match(result.stdout, /auth\.py @ [0-9a-f]{12}/);

  const content = await readText(join(target, '.memspec', 'memory', 'facts', `${id}.md`));
  const parsed = matter(content);
  const anchors = parsed.data.ext.code_anchors as Array<{ file: string; sha: string }>;
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].file, 'auth.py');
  assert.match(anchors[0].sha, /^[0-9a-f]{40}$/);
  assert.ok(parsed.data.last_verified, 'anchoring should set last_verified');
});

test('anchor warns about missing files but anchors the rest', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  await writeFile(join(target, 'real.ts'), 'export const x = 1;\n');
  const id = await addFact(target, 'Module layout');

  const result = await runCli(['anchor', id, 'real.ts', 'ghost.ts', '--cwd', target]);
  assert.match(result.stdout, /Anchored .* to 1 file\(s\)/);
  assert.match(result.stdout, /Skipped ghost\.ts/);
});

test('anchor fails when no given file exists', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  const id = await addFact(target, 'Phantom fact');

  await assert.rejects(
    () => runCli(['anchor', id, 'nope.ts', '--cwd', target]),
    (error: Error & { stderr?: string }) => {
      assert.match(`${error.message}\n${error.stderr ?? ''}`, /None of the given files exist/);
      return true;
    },
  );
});

test('anchor merges by default and replaces with --replace', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  await writeFile(join(target, 'a.ts'), 'a\n');
  await writeFile(join(target, 'b.ts'), 'b\n');
  const id = await addFact(target, 'Two files');
  const factPath = join(target, '.memspec', 'memory', 'facts', `${id}.md`);

  await runCli(['anchor', id, 'a.ts', '--cwd', target]);
  await runCli(['anchor', id, 'b.ts', '--cwd', target]);

  let anchors = matter(await readText(factPath)).data.ext.code_anchors as Array<{ file: string }>;
  assert.deepEqual(anchors.map((a) => a.file).sort(), ['a.ts', 'b.ts']);

  await runCli(['anchor', id, 'a.ts', '--cwd', target, '--replace']);
  anchors = matter(await readText(factPath)).data.ext.code_anchors as Array<{ file: string }>;
  assert.deepEqual(anchors.map((a) => a.file), ['a.ts']);
});

test('re-anchoring the same file updates its SHA', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  await writeFile(join(target, 'config.ts'), 'v1\n');
  const id = await addFact(target, 'Config shape');
  const factPath = join(target, '.memspec', 'memory', 'facts', `${id}.md`);

  await runCli(['anchor', id, 'config.ts', '--cwd', target]);
  const before = matter(await readText(factPath)).data.ext.code_anchors[0].sha;

  await writeFile(join(target, 'config.ts'), 'v2\n');
  await runCli(['anchor', id, 'config.ts', '--cwd', target]);
  const after = matter(await readText(factPath)).data.ext.code_anchors;

  assert.equal(after.length, 1);
  assert.notEqual(after[0].sha, before);
});
