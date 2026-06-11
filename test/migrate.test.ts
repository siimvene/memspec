import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';
import { makeTempProject, runCli } from './helpers.js';

const LEGACY_FACT = `---
id: ms_01HXK7Y3P5QZJKM8N4R2T6W9VB
type: fact
state: active
confidence: 0.85
created: 2026-04-04T10:30:00Z
source: claude-code
tags: [auth]
decay_after: 2030-01-01T00:00:00Z
last_verified: 2026-04-04T10:30:00Z
ext:
  code_anchors:
    - file: src/auth.ts
      sha: deadbeefdeadbeefdeadbeefdeadbeefdeadbeef
---

# Auth uses JWT

JWT with refresh tokens.
`;

const LEGACY_CORRECTED = `---
id: ms_01HXK7Y3P5QZJKM8N4R2T6W9VC
type: fact
state: corrected
confidence: 0.7
created: 2026-04-02T10:30:00Z
source: claude-code
tags: [auth]
decay_after: 2026-07-01T10:30:00Z
corrected_by: ms_01HXK7Y3P5QZJKM8N4R2T6W9VB
---

# Old auth claim

Outdated.
`;

const LEGACY_OPERATOR = `---
id: ms_01HXK7Y3P5QZJKM8N4R2T6W9VD
type: decision
state: active
confidence: 0.9
created: 2026-04-04T10:30:00Z
source: human:siim
tags: [policy]
decay_after: never
---

# Operator decision

Lock-in.
`;

const LEGACY_STALE = `---
id: ms_01HXK7Y3P5QZJKM8N4R2T6W9VE
type: fact
state: active
confidence: 0.6
created: 2024-04-04T10:30:00Z
source: claude-code
tags: [stale]
decay_after: 2024-07-01T10:30:00Z
---

# Already past TTL

Should pick up the stale flag.
`;

async function seedLegacyStore(target: string): Promise<void> {
  await runCli(['init', '--cwd', target]);
  const factsDir = join(target, '.memspec', 'memory', 'facts');
  const decisionsDir = join(target, '.memspec', 'memory', 'decisions');
  const archiveDir = join(target, '.memspec', 'archive');
  await mkdir(factsDir, { recursive: true });
  await mkdir(decisionsDir, { recursive: true });
  await mkdir(archiveDir, { recursive: true });

  await writeFile(join(factsDir, 'ms_01HXK7Y3P5QZJKM8N4R2T6W9VB.md'), LEGACY_FACT);
  await writeFile(join(archiveDir, 'ms_01HXK7Y3P5QZJKM8N4R2T6W9VC.md'), LEGACY_CORRECTED);
  await writeFile(join(decisionsDir, 'ms_01HXK7Y3P5QZJKM8N4R2T6W9VD.md'), LEGACY_OPERATOR);
  await writeFile(join(factsDir, 'ms_01HXK7Y3P5QZJKM8N4R2T6W9VE.md'), LEGACY_STALE);
}

async function loadFm(path: string): Promise<Record<string, unknown>> {
  return matter(await readFile(path, 'utf8')).data as Record<string, unknown>;
}

test('migrate dry-run reports source_kind table without writing', async () => {
  const target = await makeTempProject();
  await seedLegacyStore(target);

  const before = await readFile(
    join(target, '.memspec', 'memory', 'facts', 'ms_01HXK7Y3P5QZJKM8N4R2T6W9VB.md'),
    'utf8',
  );

  const result = await runCli(['migrate', '--cwd', target]);
  assert.match(result.stdout, /source_kind inference/);
  assert.match(result.stdout, /claude-code/);
  assert.match(result.stdout, /human:siim/);
  assert.match(result.stdout, /Dry run only/);

  const after = await readFile(
    join(target, '.memspec', 'memory', 'facts', 'ms_01HXK7Y3P5QZJKM8N4R2T6W9VB.md'),
    'utf8',
  );
  assert.equal(before, after, 'dry-run must not mutate files');
});

test('migrate --apply renames fields and remaps state', async () => {
  const target = await makeTempProject();
  await seedLegacyStore(target);

  await runCli(['migrate', '--cwd', target, '--apply']);

  const fact = await loadFm(
    join(target, '.memspec', 'memory', 'facts', 'ms_01HXK7Y3P5QZJKM8N4R2T6W9VB.md'),
  );
  assert.equal(fact.kind, 'claim');
  assert.equal(fact.check_by, '2030-01-01T00:00:00.000Z');
  assert.equal(fact.decay_after, undefined);
  assert.equal(fact.confidence, undefined);
  assert.equal((fact.ext as Record<string, unknown>).legacy_confidence, 0.85);
  assert.equal(fact.source_kind, 'agent');
  // anchors promoted out of ext.code_anchors
  assert.ok(Array.isArray(fact.anchors));
  assert.equal((fact.anchors as Array<{ file: string }>)[0].file, 'src/auth.ts');
  assert.equal(((fact.ext as Record<string, unknown>).code_anchors), undefined);
  // verified_with backfilled (has anchors + last_verified -> anchor)
  assert.equal(fact.verified_with, 'anchor');

  const archived = await loadFm(
    join(target, '.memspec', 'archive', 'ms_01HXK7Y3P5QZJKM8N4R2T6W9VC.md'),
  );
  assert.equal(archived.state, 'superseded');
  assert.equal(archived.superseded_by, 'ms_01HXK7Y3P5QZJKM8N4R2T6W9VB');
  assert.equal(archived.corrected_by, undefined);
  assert.equal(archived.supersede_reason, '(predates reason tracking)');

  const operator = await loadFm(
    join(target, '.memspec', 'memory', 'decisions', 'ms_01HXK7Y3P5QZJKM8N4R2T6W9VD.md'),
  );
  assert.equal(operator.source_kind, 'operator');
  assert.equal(operator.check_by, 'never');
  // verified_with backfilled: operator-sourced fall through to 'operator'
  assert.equal(operator.verified_with, 'operator');

  const stale = await loadFm(
    join(target, '.memspec', 'memory', 'facts', 'ms_01HXK7Y3P5QZJKM8N4R2T6W9VE.md'),
  );
  assert.equal(stale.stale, true);
});

test('migrate --apply is idempotent', async () => {
  const target = await makeTempProject();
  await seedLegacyStore(target);

  await runCli(['migrate', '--cwd', target, '--apply']);

  const factPath = join(target, '.memspec', 'memory', 'facts', 'ms_01HXK7Y3P5QZJKM8N4R2T6W9VB.md');
  const afterFirst = await readFile(factPath, 'utf8');

  const second = await runCli(['migrate', '--cwd', target, '--apply']);
  assert.match(second.stdout, /0 need migration/);

  const afterSecond = await readFile(factPath, 'utf8');
  assert.equal(afterFirst, afterSecond, 'second apply must be a no-op');
});

test('migrate --override honours operator override', async () => {
  const target = await makeTempProject();
  await seedLegacyStore(target);

  await runCli([
    'migrate', '--cwd', target, '--apply',
    '--override', 'claude-code=operator',
  ]);

  const fact = await loadFm(
    join(target, '.memspec', 'memory', 'facts', 'ms_01HXK7Y3P5QZJKM8N4R2T6W9VB.md'),
  );
  assert.equal(fact.source_kind, 'operator');
});

test('migrate normalizes legacy ext-only anchors to top-level', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  const factsDir = join(target, '.memspec', 'memory', 'facts');
  await mkdir(factsDir, { recursive: true });
  const path = join(factsDir, 'ms_01HXK7Y3P5QZJKM8N4R2T6W9VF.md');
  await writeFile(path, `---
id: ms_01HXK7Y3P5QZJKM8N4R2T6W9VF
type: fact
state: active
confidence: 0.7
created: 2026-04-04T10:30:00Z
source: openclaw-import
tags: []
decay_after: 2030-01-01T00:00:00Z
ext:
  code_anchors:
    - file: a.ts
      sha: aaaa
---

# Anchored

Body.
`);

  await runCli(['migrate', '--cwd', target, '--apply']);

  const data = await loadFm(path);
  assert.equal(data.source_kind, 'import');
  assert.ok(Array.isArray(data.anchors));
  assert.equal(((data.ext as Record<string, unknown>).code_anchors), undefined);
});

test('migrate refuses to run without an initialized store', async () => {
  const target = await makeTempProject();
  await assert.rejects(
    () => runCli(['migrate', '--cwd', target]),
    (error: Error & { stderr?: string }) => {
      assert.match(`${error.message}\n${error.stderr ?? ''}`, /No memspec store/);
      return true;
    },
  );
});

test('migrate relocates legacy captured records into the active type dir', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  const obsDir = join(target, '.memspec', 'observations', '2026-04-04');
  await mkdir(obsDir, { recursive: true });
  const fromPath = join(obsDir, 'ms_01HOBSERVATION000000000000.md');
  await writeFile(fromPath, `---
id: ms_01HOBSERVATION000000000000
type: fact
state: captured
confidence: 0.6
created: 2026-04-04T07:05:00Z
source: observer
tags: [capture]
decay_after: 2030-04-11T07:05:00Z
---

# Captured observation

Promoted to active by migrate.
`);

  await runCli(['migrate', '--cwd', target, '--apply']);

  const factsDir = join(target, '.memspec', 'memory', 'facts');
  const entries = await readdir(factsDir);
  assert.ok(entries.includes('ms_01HOBSERVATION000000000000.md'));

  const data = await loadFm(join(factsDir, 'ms_01HOBSERVATION000000000000.md'));
  assert.equal(data.state, 'active');
  assert.equal(data.kind, 'claim');
});
