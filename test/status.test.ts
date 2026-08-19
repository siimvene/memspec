import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempProject, runCli } from './helpers.js';
import { buildStatusReport } from '../src/commands/status.js';

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
  await runCli(['remember','fact', 'Fact one', '--cwd', target, '--source', 'test']);
  await runCli(['remember','fact', 'Fact two', '--cwd', target, '--source', 'test']);
  await runCli(['remember','decision', 'Dec one', '--cwd', target, '--source', 'test']);

  const result = await runCli(['status', '--cwd', target]);
  assert.match(result.stdout, /fact\s+2/);
  assert.match(result.stdout, /decision\s+1/);
  assert.match(result.stdout, /total\s+3/);
});

test('status includes legacy captured records from the observations directory as active', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);

  const obsDir = join(target, '.memspec', 'observations', '2026-04-04');
  await mkdir(obsDir, { recursive: true });

  const observationPath = join(obsDir, 'obs.md');

  // v0.3 reader normalizes legacy frontmatter (captured → active, decay_after → check_by,
  // top-level confidence → ext.legacy_confidence) so the record stays loadable.
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
  assert.match(result.stdout, /active\s+1/);
  assert.match(result.stdout, /total\s+1/);
});

// Regression for ms_01KZFCDK4RZR1S7TKC1D5JSABQ: status called loadAll() which
// did not apply the lazy stale projection, so `stale` and `sweepCandidates`
// were structurally pinned at zero. Option 1 pushes withLazyStale into the
// store read path.
test('status reports records past check_by as stale and as sweep candidates', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  await runCli(['remember', 'fact', 'Overdue fact', '--cwd', target, '--source', 'test']);

  // Push check_by into the past directly on disk, with no `stale` key — the
  // exact on-disk shape the lazy projection is meant to flag.
  const factsDir = join(target, '.memspec', 'memory', 'facts');
  const [factFile] = await readdir(factsDir);
  const factPath = join(factsDir, factFile);
  const raw = await readFile(factPath, 'utf8');
  const overdue = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  await writeFile(factPath, raw.replace(/^check_by:.*$/m, `check_by: '${overdue}'`));
  assert.doesNotMatch(await readFile(factPath, 'utf8'), /^stale:/m, 'fixture must have no stored stale key');

  const { report } = buildStatusReport({ cwd: target });
  assert.equal(report.stale, 1, 'the overdue record must be counted stale');
  assert.equal(report.sweepCandidates.length, 1, 'unanchored assertion-only stale record is a sweep candidate');
  assert.equal(report.sweepCandidates[0].title, 'Overdue fact');

  const result = await runCli(['status', '--cwd', target]);
  assert.match(result.stdout, /1 active item\(s\) flagged stale/);
  assert.match(result.stdout, /sweep candidate\(s\)/);
});
