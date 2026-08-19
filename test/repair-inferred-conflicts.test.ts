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

async function runDrain(storeRoot: string, apply = false, env?: NodeJS.ProcessEnv): Promise<string> {
  const args = [SCRIPT, storeRoot, '--drain-inferred', ...(apply ? ['--apply'] : [])];
  const { stdout } = await execFileAsync(process.execPath, args, { cwd: REPO_ROOT, env: { ...process.env, ...env } });
  return stdout;
}

async function git(dir: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, {
    cwd: dir,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 't@t',
    },
  });
}

async function gitInit(dir: string): Promise<void> {
  await git(dir, ['init', '--quiet']);
}

async function gitCommitAll(dir: string, msg: string): Promise<void> {
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '--quiet', '--no-gpg-sign', '-m', msg]);
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
    created: '2026-08-01T00:00:00.000Z', source: 'siim, 2026-08-01 (direct)', source_kind: 'operator', tags: ['test'],
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

function agentRecord(id: string, fields: Record<string, unknown>): string {
  return matter.stringify('# Agent record', {
    id, kind: 'claim', type: 'fact', state: 'active',
    created: '2026-08-01T00:00:00.000Z', source: 'agent', tags: ['test'], check_by: 'never',
    ...fields,
  });
}

test('drain-inferred on a non-git store drains nothing (fail closed)', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  const storeRoot = join(target, '.memspec');
  const factsDir = join(storeRoot, 'memory', 'facts');
  await mkdir(factsDir, { recursive: true });
  const p = join(factsDir, 'ms_01KZ000000000000000000NOGIT.md');
  await writeFile(p, agentRecord('ms_01KZ000000000000000000NOGIT', { conflicts_with: ['ms_x0000000000000000000000AA'] }));

  const out = await runDrain(storeRoot, true);
  assert.match(out, /not a git repo/);
  const after = matter(await readFile(p, 'utf8')).data;
  assert.deepEqual(after.conflicts_with, ['ms_x0000000000000000000000AA'], 'no git provenance → drain nothing');
});

test('drain-inferred drops creation-time edges but keeps asserted-marked ones', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  const storeRoot = join(target, '.memspec');
  const factsDir = join(storeRoot, 'memory', 'facts');
  await mkdir(factsDir, { recursive: true });

  const heuristic = 'ms_01KZ00000000000000000HEURI';
  const asserted = 'ms_01KZ0000000000000000ASSERT';
  const recordId = 'ms_01KZ000000000000000000DRAIN';
  const recordPath = join(factsDir, `${recordId}.md`);
  // Both edges present at file creation; only `asserted` carries the mark.
  await writeFile(recordPath, agentRecord(recordId, {
    conflicts_with: [heuristic, asserted],
    ext: { edge_sources: { [asserted]: 'asserted' } },
  }));
  await gitInit(storeRoot);
  await gitCommitAll(storeRoot, 'create record with both edges');

  const dry = await runDrain(storeRoot, false);
  assert.match(dry, /1 conflicts_with edge\(s\) would be dropped/);
  assert.deepEqual(matter(await readFile(recordPath, 'utf8')).data.conflicts_with, [heuristic, asserted],
    'dry run leaves the file untouched');

  const applied = await runDrain(storeRoot, true);
  assert.match(applied, /APPLIED/);
  const after = matter(await readFile(recordPath, 'utf8')).data;
  assert.deepEqual(after.conflicts_with, [asserted], 'asserted edge survives, creation-time heuristic dropped');
});

test('drain-inferred spares an edge introduced AFTER the record was created (S1)', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  const storeRoot = join(target, '.memspec');
  const factsDir = join(storeRoot, 'memory', 'facts');
  await mkdir(factsDir, { recursive: true });

  const deliberate = 'ms_01KZ00000000000000DELIBER8';
  const recordId = 'ms_01KZ00000000000000POSTCRE8';
  const recordPath = join(factsDir, `${recordId}.md`);
  // Creation commit: no conflict edge.
  await writeFile(recordPath, agentRecord(recordId, {}));
  await gitInit(storeRoot);
  await gitCommitAll(storeRoot, 'create record without conflict');

  // A later commit adds the edge WITHOUT a provenance mark — the pre-0.10
  // relate signature. Git history is the only thing that proves it deliberate.
  await writeFile(recordPath, agentRecord(recordId, { conflicts_with: [deliberate] }));
  await gitCommitAll(storeRoot, 'add conflict edge post-creation');

  const out = await runDrain(storeRoot, true);
  assert.match(out, /0 conflicts_with edge\(s\) would be dropped/);
  assert.match(out, /SPARED as asserted/);
  const after = matter(await readFile(recordPath, 'utf8')).data;
  assert.deepEqual(after.conflicts_with, [deliberate], 'a post-creation edge is treated as deliberate and kept');
});

test('drain-inferred skips operator records regardless of git history', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  const storeRoot = join(target, '.memspec');
  const opDir = join(storeRoot, 'memory', 'operator', 'facts');
  await mkdir(opDir, { recursive: true });

  const opPath = join(opDir, 'ms_op000000000000000000000DRN.md');
  await writeFile(opPath, matter.stringify('# Operator record', {
    id: 'ms_op000000000000000000000DRN', kind: 'claim', type: 'fact', state: 'active',
    created: '2026-08-01T00:00:00.000Z', source: 'human:siim', source_kind: 'operator', tags: ['test'],
    check_by: 'never', conflicts_with: ['ms_whatever00000000000000000'],
  }));
  await gitInit(storeRoot);
  await gitCommitAll(storeRoot, 'create operator record');

  const out = await runDrain(storeRoot, true);
  assert.match(out, /operator-stated record\(s\) SKIPPED/);
  assert.deepEqual(matter(await readFile(opPath, 'utf8')).data.conflicts_with, ['ms_whatever00000000000000000'],
    'operator conflicts are never drained');
});

// --- S3: operator detector parity with src/lib/source.ts --------------------

test('operator detection matches source.ts for every tier variant (S3)', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  const storeRoot = join(target, '.memspec');
  const factsDir = join(storeRoot, 'memory', 'facts');
  await mkdir(factsDir, { recursive: true });

  // Each case: [source, source_kind?, expectOperatorSkip]. Operator records are
  // skipped; agent/import records get drained (edge present at creation).
  const cases: Array<{ src: string; kind?: string; op: boolean; id: string }> = [
    { src: 'siim', op: true, id: 'ms_case0000000000000000000SII' },
    { src: 'user', op: true, id: 'ms_case000000000000000000USER' },
    { src: 'human:alice', op: true, id: 'ms_case00000000000000000ALICE' },
    { src: 'whatever', kind: 'operator', op: true, id: 'ms_case00000000000000000KIND0' },
    { src: 'claude-code', op: false, id: 'ms_case0000000000000000AGENT0' },
    { src: 'openclaw-import', op: false, id: 'ms_case000000000000000IMPORT0' },
  ];
  for (const c of cases) {
    await writeFile(join(factsDir, `${c.id}.md`), matter.stringify('# rec', {
      id: c.id, kind: 'claim', type: 'fact', state: 'active',
      created: '2026-08-01T00:00:00.000Z', source: c.src, ...(c.kind ? { source_kind: c.kind } : {}),
      tags: ['test'], check_by: 'never', conflicts_with: ['ms_targ0000000000000000000TT'],
    }));
  }
  await gitInit(storeRoot);
  await gitCommitAll(storeRoot, 'create tier-variant records');

  await runDrain(storeRoot, true);
  for (const c of cases) {
    const after = matter(await readFile(join(factsDir, `${c.id}.md`), 'utf8')).data;
    if (c.op) {
      assert.deepEqual(after.conflicts_with, ['ms_targ0000000000000000000TT'], `${c.src} must be treated as operator (skipped)`);
    } else {
      assert.equal(after.conflicts_with, undefined, `${c.src} must be treated as non-operator (drained)`);
    }
  }
});

// --- S2c: dropping an edge clears its provenance entry ----------------------

test('overlap repair clears the ext.edge_sources entry of a dropped edge (S2c)', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  const storeRoot = join(target, '.memspec');
  const factsDir = join(storeRoot, 'memory', 'facts');
  await mkdir(factsDir, { recursive: true });

  const t = 'ms_targ00000000000000000000XY';
  const recordId = 'ms_01KZ0000000000000000EDGSRC';
  const recordPath = join(factsDir, `${recordId}.md`);
  // conflicts_with + refines to the same target, with a NON-asserted mark that
  // must be swept away when overlap repair drops the edge.
  await writeFile(recordPath, agentRecord(recordId, {
    refines: [t], conflicts_with: [t], ext: { edge_sources: { [t]: 'inferred' } },
  }));

  await runRepair(storeRoot, true);
  const after = matter(await readFile(recordPath, 'utf8')).data;
  assert.equal(after.conflicts_with, undefined, 'overlapping conflict dropped');
  assert.equal(after.ext, undefined, 'stranded edge_sources entry removed with the edge');
});

// --- S4: undo journal written BEFORE any mutation ---------------------------

test('drain writes a planned journal before mutating; a crash leaves the plan (S4)', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  const storeRoot = join(target, '.memspec');
  const factsDir = join(storeRoot, 'memory', 'facts');
  await mkdir(factsDir, { recursive: true });

  const recordId = 'ms_01KZ0000000000000000FAULT0';
  const recordPath = join(factsDir, `${recordId}.md`);
  await writeFile(recordPath, agentRecord(recordId, { conflicts_with: ['ms_targ0000000000000000FAULT'] }));
  await gitInit(storeRoot);
  await gitCommitAll(storeRoot, 'create record');

  // Fault seam throws AFTER the planned journal, BEFORE mutation.
  await assert.rejects(() => runDrain(storeRoot, true, { MEMSPEC_REPAIR_FAULT: '1' }));

  // The record is untouched (mutation never ran)...
  const after = matter(await readFile(recordPath, 'utf8')).data;
  assert.deepEqual(after.conflicts_with, ['ms_targ0000000000000000FAULT'], 'record not mutated after fault');

  // ...but the planned journal is on disk with the full drop list.
  const { readdir } = await import('node:fs/promises');
  const journals = (await readdir(storeRoot)).filter((f) => f.startsWith('repair-inferred-conflicts.'));
  assert.equal(journals.length, 1, 'a journal exists despite the crash');
  const journal = JSON.parse(await readFile(join(storeRoot, journals[0]), 'utf8'));
  assert.equal(journal.status, 'planned');
  assert.equal(journal.dropped.length, 1);
  assert.equal(journal.dropped[0].id, recordId);
});
