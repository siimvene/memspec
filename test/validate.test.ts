import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempProject, runCli } from './helpers.js';

test('validate succeeds on a valid initialized store with one memory item', async () => {
  const repoRoot = '/tmp/memspec-12872';
  const target = await makeTempProject();

  await runCli(['init', '--cwd', target], repoRoot);
  await runCli([
    'add',
    'procedure',
    'Deploy safely',
    '--cwd',
    target,
    '--body',
    'Run tests, build, deploy, verify health',
    '--source',
    'test',
  ], repoRoot);

  const result = await runCli(['validate', '--cwd', target], repoRoot);
  assert.match(result.stdout, /Validation passed/);
});

test('validate fails on malformed frontmatter and reports the file', async () => {
  const repoRoot = '/tmp/memspec-12872';
  const target = await makeTempProject();

  await runCli(['init', '--cwd', target], repoRoot);
  const badPath = join(target, '.memspec', 'memory', 'facts', 'broken.md');
  await writeFile(
    badPath,
    `---
id: broken
type: nonsense
state: active
confidence: 2
created: nope
source: test
tags: [bad]
decay_after: later
---

# Broken

This file should fail validation.
`,
  );

  await assert.rejects(
    () => runCli(['validate', '--cwd', target], repoRoot),
    (error: Error & { stdout?: string; stderr?: string }) => {
      const output = `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
      assert.match(output, /broken\.md/);
      assert.match(output, /Validation failed/);
      return true;
    },
  );
});
