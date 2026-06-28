import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';
import { makeTempProject, runCli } from './helpers.js';

// v0.2-shape (decay_after, confidence, no kind/source_kind) record authored by an operator.
const LEGACY_V02_OPERATOR_FACT = `---
id: ms_01KV04OPERATOR000000000001
type: fact
state: active
confidence: 0.9
created: 2026-04-04T10:30:00Z
source: siim
tags: [policy]
decay_after: never
---

# Operator fact (v0.2 shape)

Authored by operator before source_kind existed.
`;

// v0.2-shape record authored by an agent — should stay in the standard tier.
const LEGACY_V02_AGENT_FACT = `---
id: ms_01KV04AGENT00000000000001
type: fact
state: active
confidence: 0.7
created: 2026-04-04T10:30:00Z
source: therin
tags: [observation]
decay_after: 2030-01-01T00:00:00Z
---

# Agent fact (v0.2 shape)

Should stay in memory/facts/.
`;

// v0.4-shape record (already normalized). Migrate must not touch it.
const V04_FACT = `---
id: ms_01KV04ALREADYFRESH00000001
kind: claim
type: fact
state: active
created: 2026-04-04T10:30:00Z
source: therin
source_kind: agent
tags: []
check_by: never
verified_with: assertion
---

# Already v0.4-shaped

Nothing to migrate.
`;

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function loadFm(path: string): Promise<Record<string, unknown>> {
  return matter(await readFile(path, 'utf8')).data as Record<string, unknown>;
}

test('migrate relocates v0.2 operator-sourced record to memory/operator/<type>s/', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);

  // Seed at the legacy (pre-Phase-4) path: memory/facts/.
  const legacyDir = join(target, '.memspec', 'memory', 'facts');
  await mkdir(legacyDir, { recursive: true });
  const legacyPath = join(legacyDir, 'ms_01KV04OPERATOR000000000001.md');
  await writeFile(legacyPath, LEGACY_V02_OPERATOR_FACT);

  await runCli(['migrate', '--cwd', target, '--apply']);

  const operatorPath = join(target, '.memspec', 'memory', 'operator', 'facts', 'ms_01KV04OPERATOR000000000001.md');
  assert.ok(await exists(operatorPath), 'operator fact must end up under memory/operator/facts/');
  assert.ok(!(await exists(legacyPath)), 'source path must be unlinked after relocation');

  const fm = await loadFm(operatorPath);
  assert.equal(fm.source_kind, 'operator');
  assert.equal(fm.check_by, 'never', 'decay_after should be renamed to check_by');
  assert.equal(fm.decay_after, undefined);
  assert.equal(fm.state, 'active');
  assert.equal(fm.kind, 'claim');
  // v0.4 additions are NOT injected when absent.
  assert.equal(fm.refines, undefined);
  assert.equal(fm.supports, undefined);
  assert.equal(fm.depends_on, undefined);
});

test('migrate leaves v0.2 agent-sourced record in the standard tier', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);

  const legacyDir = join(target, '.memspec', 'memory', 'facts');
  await mkdir(legacyDir, { recursive: true });
  const legacyPath = join(legacyDir, 'ms_01KV04AGENT00000000000001.md');
  await writeFile(legacyPath, LEGACY_V02_AGENT_FACT);

  await runCli(['migrate', '--cwd', target, '--apply']);

  assert.ok(await exists(legacyPath), 'agent-sourced record stays at memory/facts/');
  const operatorPath = join(target, '.memspec', 'memory', 'operator', 'facts', 'ms_01KV04AGENT00000000000001.md');
  assert.ok(!(await exists(operatorPath)), 'agent record must not land in operator tier');

  const fm = await loadFm(legacyPath);
  assert.equal(fm.source_kind, 'agent');
  assert.equal(fm.check_by, '2030-01-01T00:00:00.000Z');
});

test('migrate is a no-op for v0.4-shape records; second --apply is also a no-op', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);

  // Mixed seed: one v0.2 agent record + one v0.4 record.
  const factsDir = join(target, '.memspec', 'memory', 'facts');
  await mkdir(factsDir, { recursive: true });
  const v02Path = join(factsDir, 'ms_01KV04AGENT00000000000001.md');
  const v04Path = join(factsDir, 'ms_01KV04ALREADYFRESH00000001.md');
  await writeFile(v02Path, LEGACY_V02_AGENT_FACT);
  await writeFile(v04Path, V04_FACT);

  const v04Before = await readFile(v04Path, 'utf8');

  const first = await runCli(['migrate', '--cwd', target, '--apply']);
  assert.match(first.stdout, /1 need migration/, 'only the v0.2 record should be touched');

  const v04After = await readFile(v04Path, 'utf8');
  assert.equal(v04After, v04Before, 'v0.4-shape record must be byte-identical after first --apply');

  const second = await runCli(['migrate', '--cwd', target, '--apply']);
  assert.match(second.stdout, /0 need migration/, 'second --apply must be a no-op');

  const v04After2 = await readFile(v04Path, 'utf8');
  assert.equal(v04After2, v04Before, 'v0.4 record stays byte-identical across repeated apply');
});

test('migrate --dry-run surfaces operator-tier relocations and v0.4 additions line', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);

  const legacyDir = join(target, '.memspec', 'memory', 'facts');
  await mkdir(legacyDir, { recursive: true });
  await writeFile(join(legacyDir, 'ms_01KV04OPERATOR000000000001.md'), LEGACY_V02_OPERATOR_FACT);

  const result = await runCli(['migrate', '--cwd', target]);
  assert.match(result.stdout, /Operator-tier relocations \(1\)/);
  assert.match(result.stdout, /ms_01KV04OPERATOR000000000001/);
  assert.match(result.stdout, /memory\/operator\/facts/);
  assert.match(result.stdout, /source: siim/);
  assert.match(result.stdout, /Schema field migrations:/);
  assert.match(result.stdout, /v0\.4 additions: No new fields to backfill/);
  assert.match(result.stdout, /Dry run only/);
});

test('migrate apply creates the operator subtree on demand', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  // init does not create memory/operator/<type>s/; migrate should mkdir -p it.

  const legacyDir = join(target, '.memspec', 'memory', 'facts');
  await mkdir(legacyDir, { recursive: true });
  await writeFile(join(legacyDir, 'ms_01KV04OPERATOR000000000001.md'), LEGACY_V02_OPERATOR_FACT);

  const operatorDir = join(target, '.memspec', 'memory', 'operator', 'facts');
  assert.ok(!(await exists(operatorDir)), 'operator subtree should not exist before --apply');

  await runCli(['migrate', '--cwd', target, '--apply']);

  assert.ok(await exists(operatorDir), 'migrate --apply must mkdir -p the operator subtree');
});

test('migrate write-then-unlink leaves no orphan at the source path', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);

  const legacyDir = join(target, '.memspec', 'memory', 'facts');
  await mkdir(legacyDir, { recursive: true });
  const legacyPath = join(legacyDir, 'ms_01KV04OPERATOR000000000001.md');
  await writeFile(legacyPath, LEGACY_V02_OPERATOR_FACT);

  await runCli(['migrate', '--cwd', target, '--apply']);

  // Source unlinked, target written. No duplicate id on disk.
  assert.ok(!(await exists(legacyPath)), 'source file must be unlinked once target is written');
  const targetPath = join(target, '.memspec', 'memory', 'operator', 'facts', 'ms_01KV04OPERATOR000000000001.md');
  assert.ok(await exists(targetPath));
});
