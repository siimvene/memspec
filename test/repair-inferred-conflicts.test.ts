import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import matter from 'gray-matter';
import { makeTempProject, runCli, REPO_ROOT } from './helpers.js';

const execFileAsync = promisify(execFile);
const SCRIPT = join(REPO_ROOT, 'bin', 'repair-inferred-conflicts.mjs');

async function runRepair(storeRoot: string, apply = false): Promise<string> {
  const args = [SCRIPT, storeRoot, ...(apply ? ['--apply'] : [])];
  const { stdout } = await execFileAsync(process.execPath, args, { cwd: REPO_ROOT });
  return stdout;
}

async function runDrain(storeRoot: string, apply = false): Promise<string> {
  const args = [SCRIPT, storeRoot, '--drain-inferred', ...(apply ? ['--apply'] : [])];
  const { stdout } = await execFileAsync(process.execPath, args, { cwd: REPO_ROOT });
  return stdout;
}

// A record carrying the same target in BOTH conflicts_with and a positive edge
// is the corruption signature from ms_01KZJXHBZT6YXY9P500JFCE4SX.
function corruptedRecord(id: string, overlapTarget: string, legitConflict: string): string {
  return matter.stringify(
    '# Corrupted record\n\nBody stays intact.',
    {
      id,
      kind: 'claim',
      type: 'fact',
      state: 'active',
      created: '2026-08-01T00:00:00.000Z',
      source: 'agent',
      tags: ['test'],
      check_by: 'never',
      refines: [overlapTarget],
      // overlapTarget is inferred-and-declared (drop it); legitConflict is a
      // real, undeclared conflict (keep it).
      conflicts_with: [overlapTarget, legitConflict],
    },
  );
}

test('repair drops the inferred conflict but keeps real conflicts and the positive edge', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  const storeRoot = join(target, '.memspec');
  const factsDir = join(storeRoot, 'memory', 'facts');
  await mkdir(factsDir, { recursive: true });

  const recordId = 'ms_01KZ000000000000000000000X';
  const overlapTarget = 'ms_01KZ0000000000000000000AAA';
  const legitConflict = 'ms_01KZ0000000000000000000BBB';
  const recordPath = join(factsDir, `${recordId}.md`);
  await writeFile(recordPath, corruptedRecord(recordId, overlapTarget, legitConflict));

  const dry = await runRepair(storeRoot, false);
  assert.match(dry, /1 record\(s\) carry a target in both/);
  assert.match(dry, /DRY-RUN/);
  // Dry run must not touch the file.
  const afterDry = matter(await readFile(recordPath, 'utf8')).data;
  assert.deepEqual(afterDry.conflicts_with, [overlapTarget, legitConflict]);

  const applied = await runRepair(storeRoot, true);
  assert.match(applied, /APPLIED/);

  const afterApply = matter(await readFile(recordPath, 'utf8')).data;
  assert.deepEqual(afterApply.conflicts_with, [legitConflict], 'real, undeclared conflict is preserved');
  assert.deepEqual(afterApply.refines, [overlapTarget], 'the caller-declared positive edge is preserved');

  // Idempotent — a second dry run finds nothing left.
  const second = await runRepair(storeRoot, false);
  assert.match(second, /0 record\(s\) carry a target in both/);
});

test('repair removes conflicts_with entirely when the only entry was inferred', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  const storeRoot = join(target, '.memspec');
  const factsDir = join(storeRoot, 'memory', 'facts');
  await mkdir(factsDir, { recursive: true });

  const recordId = 'ms_01KZ000000000000000000000Y';
  const overlapTarget = 'ms_01KZ0000000000000000000CCC';
  const recordPath = join(factsDir, `${recordId}.md`);
  await writeFile(recordPath, matter.stringify('# Only inferred', {
    id: recordId, kind: 'claim', type: 'fact', state: 'active',
    created: '2026-08-01T00:00:00.000Z', source: 'agent', tags: ['test'],
    check_by: 'never', supports: [overlapTarget], conflicts_with: [overlapTarget],
  }));

  await runRepair(storeRoot, true);
  const after = matter(await readFile(recordPath, 'utf8')).data;
  assert.equal(after.conflicts_with, undefined, 'empty conflicts_with is removed, not left as []');
  assert.deepEqual(after.supports, [overlapTarget]);
});

test('repair skips operator-stated records and writes an undo journal on --apply', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  const storeRoot = join(target, '.memspec');
  const factsDir = join(storeRoot, 'memory', 'facts');
  await mkdir(factsDir, { recursive: true });

  const operatorPath = join(factsDir, 'ms_op000000000000000000000000.md');
  await writeFile(operatorPath, matter.stringify('# Operator record', {
    id: 'ms_op000000000000000000000000', kind: 'claim', type: 'fact', state: 'active',
    created: '2026-08-01T00:00:00.000Z', source: 'siim, 2026-08-01 (direct)', tags: ['test'],
    check_by: 'never', refines: ['ms_target'], conflicts_with: ['ms_target'],
  }));
  const agentPath = join(factsDir, 'ms_ag000000000000000000000000.md');
  await writeFile(agentPath, corruptedRecord('ms_ag000000000000000000000000', 'ms_target', 'ms_other'));

  const out = await runRepair(storeRoot, true);
  assert.match(out, /operator-stated record\(s\) SKIPPED/);
  assert.match(out, /undo journal written/);

  const operatorAfter = matter(await readFile(operatorPath, 'utf8')).data;
  assert.deepEqual(operatorAfter.conflicts_with, ['ms_target'], 'operator records are never rewritten');

  const journalPath = out.match(/undo journal written: (.+)/)?.[1]?.trim();
  assert.ok(journalPath, 'journal path is printed');
  const journal = JSON.parse(await readFile(journalPath!, 'utf8'));
  assert.equal(journal.dropped.length, 1);
  assert.equal(journal.dropped[0].id, 'ms_ag000000000000000000000000');
});

// --- --drain-inferred mode ---------------------------------------------------

test('drain-inferred drops heuristic conflicts on agent records but keeps asserted ones', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  const storeRoot = join(target, '.memspec');
  const factsDir = join(storeRoot, 'memory', 'facts');
  await mkdir(factsDir, { recursive: true });

  const heuristic = 'ms_01KZ00000000000000000HEURI';
  const asserted = 'ms_01KZ0000000000000000ASSERT';
  const recordId = 'ms_01KZ000000000000000000DRAIN';
  const recordPath = join(factsDir, `${recordId}.md`);
  await writeFile(recordPath, matter.stringify('# Agent record', {
    id: recordId, kind: 'claim', type: 'fact', state: 'active',
    created: '2026-08-01T00:00:00.000Z', source: 'agent', tags: ['test'],
    check_by: 'never',
    conflicts_with: [heuristic, asserted],
    // Only `asserted` carries the deliberate mark; `heuristic` is legacy backlog.
    ext: { edge_sources: { [asserted]: 'asserted' } },
  }));

  const dry = await runDrain(storeRoot, false);
  assert.match(dry, /drain-inferred/);
  assert.match(dry, /DRY-RUN/);
  assert.match(dry, /1 conflicts_with edge\(s\) would be dropped/);
  // Dry run leaves the file untouched.
  const afterDry = matter(await readFile(recordPath, 'utf8')).data;
  assert.deepEqual(afterDry.conflicts_with, [heuristic, asserted]);

  const applied = await runDrain(storeRoot, true);
  assert.match(applied, /APPLIED/);
  const afterApply = matter(await readFile(recordPath, 'utf8')).data;
  assert.deepEqual(afterApply.conflicts_with, [asserted], 'asserted edge survives, heuristic dropped');

  // Idempotent — a second drain finds nothing left to drop.
  const second = await runDrain(storeRoot, false);
  assert.match(second, /0 conflicts_with edge\(s\) would be dropped/);
});

test('drain-inferred skips operator records and reports them', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  const storeRoot = join(target, '.memspec');
  const factsDir = join(storeRoot, 'memory', 'facts');
  await mkdir(factsDir, { recursive: true });

  const opPath = join(factsDir, 'ms_op000000000000000000000DRN.md');
  await writeFile(opPath, matter.stringify('# Operator record', {
    id: 'ms_op000000000000000000000DRN', kind: 'claim', type: 'fact', state: 'active',
    created: '2026-08-01T00:00:00.000Z', source: 'siim (direct)', tags: ['test'],
    check_by: 'never', conflicts_with: ['ms_whatever00000000000000000'],
  }));

  const out = await runDrain(storeRoot, true);
  assert.match(out, /operator-stated record\(s\) SKIPPED/);

  const after = matter(await readFile(opPath, 'utf8')).data;
  assert.deepEqual(after.conflicts_with, ['ms_whatever00000000000000000'],
    'operator conflicts are never drained');
});
