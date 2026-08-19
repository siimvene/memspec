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
