import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTempProject, runCli } from './helpers.js';
import { runObserve } from '../src/commands/observe.js';
import { runRemember } from '../src/commands/remember.js';
import { runRelate } from '../src/commands/relate.js';
import { runOutcome } from '../src/commands/outcome.js';
import { buildStatusReport } from '../src/commands/status.js';
import { formatCoverageLine, searchPayload } from '../src/commands/search.js';
import { appendOutcome } from '../src/lib/outcomes.js';
import { attachEvidence } from '../src/lib/evidence.js';
import { MemspecStore } from '../src/lib/store.js';

// Regression tests for the 0.11.0 release-gate consort panel (Codex + Gemini,
// 2026-09-16). Each test names the finding it pins.

function mdFiles(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith('.md')).sort().map((f) => join(dir, f));
}

function layerDecl(entries: Array<{ name: string; path: string; priority: number; writable: boolean }>): string {
  return 'stores:\n' + entries.map((e) => `  - name: ${e.name}\n    path: ${e.path}\n    priority: ${e.priority}\n    writable: ${e.writable}\n`).join('');
}

async function readonlyTeamFixture() {
  const personal = await makeTempProject();
  const team = await makeTempProject();
  await runCli(['init', '--cwd', personal, '--no-interactive', '--no-install-hooks']);
  await runCli(['init', '--cwd', team, '--no-interactive', '--no-install-hooks']);
  const teamRec = runRemember('fact', 'Team policy record', { cwd: team, body: 'Lives in the read-only layer.', source: 'team:eval' });
  const personalMemspec = join(personal, '.memspec');
  const teamMemspec = join(team, '.memspec');
  await writeFile(join(personalMemspec, 'config.yaml'), layerDecl([
    { name: 'personal', path: personalMemspec, priority: 0, writable: true },
    { name: 'team', path: teamMemspec, priority: 10, writable: false },
  ]));
  return { personal, team, personalMemspec, teamMemspec, teamId: teamRec.id };
}

test('gate/observe: observe follows a .memspec.yaml pointer like remember — no phantom <cwd>/.memspec, refused when the only layer is read-only', async () => {
  const fx = await readonlyTeamFixture();
  const repo = await makeTempProject();
  writeFileSync(join(repo, '.memspec.yaml'), layerDecl([
    { name: 'personal', path: fx.personalMemspec, priority: 0, writable: true },
    { name: 'team', path: fx.teamMemspec, priority: 10, writable: false },
  ]));

  const result = runObserve({ cwd: repo, text: 'Observed from a pointer-bound repo.' });
  assert.equal(existsSync(join(repo, '.memspec')), false, 'no phantom store was created at the cwd');
  assert.ok(result.filePath.startsWith(fx.personalMemspec + '/'), `observation landed in the writable personal layer, got ${result.filePath}`);
  const personal = new MemspecStore(fx.personalMemspec);
  assert.ok(personal.findById(result.id), 'observation is readable from the personal store');

  const roRepo = await makeTempProject();
  writeFileSync(join(roRepo, '.memspec.yaml'), layerDecl([{ name: 'team', path: fx.teamMemspec, priority: 10, writable: false }]));
  assert.throws(() => runObserve({ cwd: roRepo, text: 'Must not land in a read-only layer.' }), /writable|read-only/i);
  assert.equal(existsSync(join(roRepo, '.memspec')), false);
  assert.equal(mdFiles(join(fx.teamMemspec, 'memory')).length, 1, 'team layer untouched');
});

test('gate/layers: an absent configured layer is disclosed by search (payload + text) and status', async () => {
  const project = await makeTempProject();
  const store = new MemspecStore(project, { walk: false });
  store.init();
  const missing = join(project, 'not-cloned', 'team-specs', '.memspec');
  writeFileSync(store.configPath, layerDecl([
    { name: 'personal', path: store.root, priority: 0, writable: true },
    { name: 'team', path: missing, priority: 10, writable: false },
  ]));

  const payload = searchPayload('anything at all', { cwd: project });
  assert.equal(payload.coverage, 'none');
  assert.deepEqual(payload.layers_unavailable, [{ name: 'team', path: missing, writable: false }]);
  const text = formatCoverageLine(payload);
  assert.match(text, /^Coverage: none/);
  assert.match(text, /Warning: store layer 'team' \(read-only\) is not available at .*not-cloned.*; its records are missing from this view/);

  const { report } = buildStatusReport({ cwd: project });
  assert.deepEqual(report.layers_unavailable, [{ name: 'team', path: missing, writable: false }]);

  // Healthy layered store: field absent, no warning line.
  const ok = searchPayload('anything at all', { cwd: (await readonlyTeamFixture()).personal });
  assert.equal(ok.layers_unavailable, undefined);
  assert.doesNotMatch(formatCoverageLine(ok), /Warning:/);
});

test('gate/outcomes: an outcome-only write on a pre-0.11 store ignores outcomes.jsonl first; a lost receipt is reported, not silently swallowed', async () => {
  const project = await makeTempProject();
  await runCli(['init', '--cwd', project, '--no-interactive', '--no-install-hooks']);
  const root = join(project, '.memspec');
  const rec = runRemember('fact', 'Outcome target', { cwd: project, body: 'x', source: 'human:test' });
  // Simulate a pre-0.11 store: strip the 0.11 telemetry entries from .gitignore.
  const gi = join(root, '.gitignore');
  writeFileSync(gi, readFileSync(gi, 'utf8').split('\n').filter((l) => !/outcomes\.jsonl|local\/|logs\//.test(l)).join('\n'));
  assert.doesNotMatch(readFileSync(gi, 'utf8'), /outcomes\.jsonl/);

  assert.equal(appendOutcome(root, rec.id, 'useful'), true);
  assert.match(readFileSync(gi, 'utf8'), /^outcomes\.jsonl$/m, 'gitignore gained the entry on the outcome-only write');
  assert.match(readFileSync(join(root, 'outcomes.jsonl'), 'utf8'), /"outcome":"useful"/);

  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    chmodSync(join(root, 'outcomes.jsonl'), 0o444);
    try {
      assert.equal(appendOutcome(root, rec.id, 'dead_end'), false);
      assert.throws(() => runOutcome(rec.id, 'dead_end', { cwd: project }), /Could not record outcome/);
    } finally {
      chmodSync(join(root, 'outcomes.jsonl'), 0o644);
    }
  }
});

test('gate/relate: a writable personal record can relate to a read-only team record (target found in the layered view); the team record is never written', async () => {
  const fx = await readonlyTeamFixture();
  const mine = runRemember('fact', 'Personal note about the team policy', { cwd: fx.personal, body: 'y', source: 'human:test' });
  const teamFiles = mdFiles(join(fx.teamMemspec, 'memory'));
  assert.equal(teamFiles.length, 1);
  const before = readFileSync(teamFiles[0], 'utf8');

  const res = runRelate({ cwd: fx.personal, from: mine.id, to: fx.teamId, type: 'supports' });
  assert.equal(res.added, true);
  const personal = new MemspecStore(fx.personalMemspec);
  assert.deepEqual(personal.findById(mine.id)?.supports, [fx.teamId]);
  const after = readFileSync(teamFiles[0], 'utf8');
  assert.equal(after, before, 'read-only layer untouched');

  assert.throws(() => runRelate({ cwd: fx.personal, from: mine.id, to: 'ms_DOESNOTEXIST0000000000000', type: 'supports' }), /Memory not found/);
});

test('gate/evidence: a symlinked evidence/ root or <sha> shard is refused before any copy — nothing lands outside the store', async () => {
  const project = await makeTempProject();
  await runCli(['init', '--cwd', project, '--no-interactive', '--no-install-hooks']);
  const root = join(project, '.memspec');
  const outside = await mkdtemp(join(tmpdir(), 'memspec-ev-escape-'));
  const src = join(outside, 'artifact.txt');
  writeFileSync(src, 'harmless artifact\n');
  const prefix = createHash('sha256').update(readFileSync(src)).digest('hex').slice(0, 12);

  // Case 1: evidence/ itself is a symlink out of the store (planted via a synced repo).
  const escape1 = join(outside, 'escape1');
  mkdirSync(escape1);
  symlinkSync(escape1, join(root, 'evidence'));
  assert.throws(() => attachEvidence(root, src), /symlinked directory \(evidence\)/);
  assert.equal(readdirSync(escape1).length, 0, 'nothing written through the symlink');
  assert.ok(lstatSync(join(root, 'evidence')).isSymbolicLink());

  // Case 2: evidence/ is real but the content-addressed shard is a symlink.
  const project2 = await makeTempProject();
  await runCli(['init', '--cwd', project2, '--no-interactive', '--no-install-hooks']);
  const root2 = join(project2, '.memspec');
  const escape2 = join(outside, 'escape2');
  mkdirSync(escape2);
  mkdirSync(join(root2, 'evidence'), { recursive: true });
  symlinkSync(escape2, join(root2, 'evidence', prefix));
  assert.throws(() => attachEvidence(root2, src), new RegExp(`symlinked directory \\(evidence/${prefix}\\)`));
  assert.equal(readdirSync(escape2).length, 0, 'nothing written through the shard symlink');

  // Control: a real evidence tree still works.
  const project3 = await makeTempProject();
  await runCli(['init', '--cwd', project3, '--no-interactive', '--no-install-hooks']);
  const entry = attachEvidence(join(project3, '.memspec'), src);
  assert.equal(entry.path, `evidence/${prefix}/artifact.txt`);
});
