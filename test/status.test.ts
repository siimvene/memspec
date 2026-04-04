import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempProject, runCli } from './helpers.js';

test('status shows empty store summary', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);

  const result = await runCli(['status', '--cwd', target]);
  assert.match(result.stdout, /Memspec Store/);
  assert.match(result.stdout, /fact/);
  assert.match(result.stdout, /decision/);
  assert.match(result.stdout, /procedure/);
  assert.match(result.stdout, /total\s+0/);
});

test('status counts active items by type', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  await runCli(['add', 'fact', 'Fact one', '--cwd', target, '--source', 'test']);
  await runCli(['add', 'fact', 'Fact two', '--cwd', target, '--source', 'test']);
  await runCli(['add', 'decision', 'Dec one', '--cwd', target, '--source', 'test']);

  const result = await runCli(['status', '--cwd', target]);
  assert.match(result.stdout, /fact\s+2/);
  assert.match(result.stdout, /decision\s+1/);
  assert.match(result.stdout, /total\s+3/);
});

test('status includes captured observations from observations directory', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);

  const obsDir = join(target, '.memspec', 'observations', '2026-04-04');
  await mkdir(obsDir, { recursive: true });

  const observationPath = join(obsDir, 'obs.md');

  await writeFile(
    observationPath,
    `---
id: ms_01HOBSERVATION000000000000
type: fact
state: captured
confidence: 0.6
created: 2026-04-04T07:05:00Z
source: observer
tags: [capture]
decay_after: 2026-04-11T07:05:00Z
---

# Captured observation

Observed before promotion into active memory.
`,
  );

  const result = await runCli(['status', '--cwd', target]);
  assert.match(result.stdout, /captured\s+1/);
  assert.match(result.stdout, /total\s+1/);
});
