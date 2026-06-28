import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import matter from 'gray-matter';
import { runRemember } from '../src/commands/remember.js';
import { runSupersede } from '../src/commands/supersede.js';
import { MemspecStore } from '../src/lib/store.js';

async function makeProject(): Promise<string> {
  const target = await mkdtemp(join(tmpdir(), 'memspec-op-tier-'));
  const store = new MemspecStore(target);
  store.init();
  return target;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// --- 4.1 / 4.2 — write routing -------------------------------------------------

test('operator source writes to memory/operator/<type>s/', async () => {
  const target = await makeProject();

  const result = runRemember('fact', 'Auth uses OAuth2', {
    cwd: target,
    body: 'Stated by operator',
    source: 'siim',
  });

  const operatorPath = join(target, '.memspec', 'memory', 'operator', 'facts', `${result.id}.md`);
  const standardPath = join(target, '.memspec', 'memory', 'facts', `${result.id}.md`);

  assert.ok(await exists(operatorPath), 'operator-sourced fact should land in memory/operator/facts/');
  assert.ok(!(await exists(standardPath)), 'operator-sourced fact must not land in standard memory/facts/');
});

test('agent source writes to memory/<type>s/ (unchanged)', async () => {
  const target = await makeProject();

  const result = runRemember('decision', 'Picked X over Y', {
    cwd: target,
    body: 'rationale',
    source: 'therin',
  });

  const standardPath = join(target, '.memspec', 'memory', 'decisions', `${result.id}.md`);
  const operatorPath = join(target, '.memspec', 'memory', 'operator', 'decisions', `${result.id}.md`);

  assert.ok(await exists(standardPath), 'agent-sourced decision should land in standard memory/decisions/');
  assert.ok(!(await exists(operatorPath)), 'agent-sourced decision must not land in operator path');
});

test('import source writes to standard memory/<type>s/', async () => {
  const target = await makeProject();

  const result = runRemember('procedure', 'How to deploy', {
    cwd: target,
    body: 'steps',
    source: 'openclaw-import',
  });

  const standardPath = join(target, '.memspec', 'memory', 'procedures', `${result.id}.md`);
  const operatorPath = join(target, '.memspec', 'memory', 'operator', 'procedures', `${result.id}.md`);

  assert.ok(await exists(standardPath), 'import-sourced procedure should land in standard memory/procedures/');
  assert.ok(!(await exists(operatorPath)), 'only operator tier gets the separate path');
});

test('human:<name> sources also route to operator tier', async () => {
  const target = await makeProject();

  const result = runRemember('fact', 'Operator told me this', {
    cwd: target,
    body: 'data',
    source: 'human:alice',
  });

  const operatorPath = join(target, '.memspec', 'memory', 'operator', 'facts', `${result.id}.md`);
  assert.ok(await exists(operatorPath), 'human:<name> sources should route to operator tier');
});

// --- 4.2 — reader merges paths -------------------------------------------------

test('search and get find records across both tiers', async () => {
  const target = await makeProject();

  const opItem = runRemember('fact', 'Operator-tier fact about deploys', {
    cwd: target,
    body: 'authoritative truth',
    source: 'siim',
  });
  const agentItem = runRemember('fact', 'Agent-tier fact about deploys', {
    cwd: target,
    body: 'observed truth',
    source: 'therin',
  });

  const store = new MemspecStore(target);

  // findById finds both
  assert.equal(store.findById(opItem.id)?.id, opItem.id);
  assert.equal(store.findById(agentItem.id)?.id, agentItem.id);

  // loadActive returns both
  const active = store.loadActive();
  const ids = active.map((i) => i.id);
  assert.ok(ids.includes(opItem.id));
  assert.ok(ids.includes(agentItem.id));

  // search finds both
  const results = store.search('deploys');
  const resultIds = results.map((i) => i.id);
  assert.ok(resultIds.includes(opItem.id), 'search should reach operator-tier records');
  assert.ok(resultIds.includes(agentItem.id), 'search should reach standard-tier records');
});

// --- 4.2 — collision defence ---------------------------------------------------

test('id collision: operator path wins, stderr warning issued', async () => {
  const target = await makeProject();
  const id = 'ms_01KCOLLISIONABCDEFGHJKMNPQ';
  const now = new Date().toISOString();

  const standardBody = `---
id: ${id}
kind: claim
type: fact
state: active
created: ${now}
source: therin
source_kind: agent
tags: []
check_by: never
verified_with: assertion
---

# Standard tier copy

agent body
`;

  const operatorBody = `---
id: ${id}
kind: claim
type: fact
state: active
created: ${now}
source: siim
source_kind: operator
tags: []
check_by: never
verified_with: operator
---

# Operator tier copy

operator body
`;

  await writeFile(join(target, '.memspec', 'memory', 'facts', `${id}.md`), standardBody);
  // mkdir for operator subtree
  const fs = await import('node:fs/promises');
  await fs.mkdir(join(target, '.memspec', 'memory', 'operator', 'facts'), { recursive: true });
  await writeFile(join(target, '.memspec', 'memory', 'operator', 'facts', `${id}.md`), operatorBody);

  // Capture stderr
  const originalWrite = process.stderr.write.bind(process.stderr);
  const captured: string[] = [];
  process.stderr.write = ((chunk: unknown) => {
    captured.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  let winner;
  try {
    const store = new MemspecStore(target);
    winner = store.findById(id);
  } finally {
    process.stderr.write = originalWrite;
  }

  assert.ok(winner, 'expected to find the id');
  assert.equal(winner!.source, 'siim', 'operator-tier record should win the collision');
  assert.equal(winner!.title, 'Operator tier copy');

  const stderrText = captured.join('');
  assert.match(stderrText, /id collision for ms_01KCOLLISIONABCDEFGHJKMNPQ/);
  assert.match(stderrText, /operator path wins/);
});

// --- 4.3 — supersede + operator guard -----------------------------------------

test('agent cannot supersede operator-sourced record without override_operator', async () => {
  const target = await makeProject();

  const opItem = runRemember('fact', 'Operator claim', {
    cwd: target,
    body: 'truth',
    source: 'siim',
  });

  assert.throws(
    () =>
      runSupersede(opItem.id, {
        cwd: target,
        reason: 'agent disagrees',
        body: 'new content',
        source: 'therin',
      }),
    /operator-sourced/,
    'should throw without override_operator',
  );

  // File untouched in operator tier
  const opPath = join(target, '.memspec', 'memory', 'operator', 'facts', `${opItem.id}.md`);
  assert.ok(await exists(opPath), 'original operator record should be untouched');
});

test('agent supersedes operator record with override_operator → new record lands in standard tier, original archived', async () => {
  const target = await makeProject();

  const opItem = runRemember('fact', 'Operator claim about caching', {
    cwd: target,
    body: 'TTL is 5min',
    source: 'siim',
  });

  // Sanity: original is in operator tier
  const opPath = join(target, '.memspec', 'memory', 'operator', 'facts', `${opItem.id}.md`);
  assert.ok(await exists(opPath));

  const result = runSupersede(opItem.id, {
    cwd: target,
    reason: 'TTL changed to 10min',
    body: 'TTL is 10min',
    source: 'therin',
    overrideOperator: true,
  });

  // Replacement is agent-sourced → standard tier
  const replacementStandardPath = join(target, '.memspec', 'memory', 'facts', `${result.survivor_id}.md`);
  const replacementOperatorPath = join(target, '.memspec', 'memory', 'operator', 'facts', `${result.survivor_id}.md`);
  assert.ok(await exists(replacementStandardPath), 'agent-sourced replacement should land in standard tier');
  assert.ok(!(await exists(replacementOperatorPath)), 'agent-sourced replacement must not land in operator tier');

  // Original archived (archive is flat, single-tier)
  assert.ok(!(await exists(opPath)), 'original should be removed from operator tier');
  const archivePath = join(target, '.memspec', 'archive', `${opItem.id}.md`);
  assert.ok(await exists(archivePath), 'original should be in archive/');

  // Override is logged in the supersede reason
  const archived = matter(await import('node:fs/promises').then((m) => m.readFile(archivePath, 'utf8')));
  assert.match(String(archived.data.supersede_reason), /override_operator used/);
});

test('operator supersedes operator record (with override) → replacement stays in operator tier', async () => {
  // The operator guard fires for any caller targeting an operator-tier record
  // (existing v0.3 behavior — Phase 4 doesn't relax it). The interesting part
  // for Phase 4 is path routing: an operator-sourced replacement still lands
  // in the operator tier even when minted via supersede.
  const target = await makeProject();

  const opItem = runRemember('fact', 'Initial operator claim', {
    cwd: target,
    body: 'v1',
    source: 'siim',
  });

  const result = runSupersede(opItem.id, {
    cwd: target,
    reason: 'refined',
    body: 'v2 refined',
    source: 'siim',
    overrideOperator: true,
  });

  const replacementOperatorPath = join(target, '.memspec', 'memory', 'operator', 'facts', `${result.survivor_id}.md`);
  const replacementStandardPath = join(target, '.memspec', 'memory', 'facts', `${result.survivor_id}.md`);
  assert.ok(await exists(replacementOperatorPath), 'operator-sourced replacement should stay in operator tier');
  assert.ok(!(await exists(replacementStandardPath)));
});

// --- 4.2 — observation paths are tier-agnostic --------------------------------

test('operator-sourced observation does NOT split into operator subdir', async () => {
  // Observations are tier-agnostic per Phase 4 design. Even if an operator
  // somehow writes one, it stays in observations/.
  const target = await makeProject();
  const id = 'ms_01KOBSERVATIONOPERATOR0000';
  const now = new Date().toISOString();

  const obsBody = `---
id: ${id}
kind: observation
state: active
created: ${now}
source: siim
source_kind: operator
tags: []
check_by: never
---

# Operator observation

tier-agnostic
`;

  await writeFile(join(target, '.memspec', 'observations', `${id}.md`), obsBody);

  const store = new MemspecStore(target);
  const found = store.findById(id);
  assert.ok(found, 'observation should be readable');
  assert.equal(found!.filePath, join(target, '.memspec', 'observations', `${id}.md`));

  // operator subdir should not exist under observations
  const opObsDir = join(target, '.memspec', 'observations', 'operator');
  const dirs = await readdir(join(target, '.memspec', 'observations'));
  assert.ok(!dirs.includes('operator'), `observations/ should not contain an operator subdir: got ${dirs.join(',')}`);
  // (silence unused var warning)
  void opObsDir;
});
