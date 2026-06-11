import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempProject, runCli } from './helpers.js';

test('context returns empty section when no memories exist', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target, '--no-install-hooks']);

  const result = await runCli(['context', '--cwd', target]);
  assert.match(result.stdout, /## Project memory — 0 active claims/);
  assert.match(result.stdout, /No active memories/);
});

test('context returns markdown section listing active memories', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target, '--no-install-hooks']);
  await runCli(['add', 'fact', 'Auth uses JWT', '--cwd', target, '--body', 'JWT with 15min expiry', '--source', 'test']);
  await runCli(['add', 'decision', 'Chose REST', '--cwd', target, '--body', 'REST over GraphQL for simplicity', '--source', 'test']);

  const result = await runCli(['context', '--cwd', target]);
  // Boot header carries the store size and points at the full readout.
  assert.match(result.stdout, /## Project memory — 2 active claims \(memspec_status for detail\)/);
  // Each line carries id, type, source kind, and a witness marker so booted
  // memories are immediately actionable.
  assert.match(result.stdout, /- ms_[0-9A-HJKMNP-TV-Z]{26} fact \[agent\] ✓0d: Auth uses JWT — JWT with 15min expiry/);
  assert.match(result.stdout, /- ms_[0-9A-HJKMNP-TV-Z]{26} decision \[agent\] ✓0d: Chose REST — REST over GraphQL/);
});

test('context marks anchored memories with the anchor witness', async () => {
  const { writeFile } = await import('node:fs/promises');
  const { readdir } = await import('node:fs/promises');
  const { join: joinPath } = await import('node:path');
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target, '--no-install-hooks']);
  await writeFile(joinPath(target, 'auth.py'), 'argon2id\n');
  await runCli(['add', 'fact', 'Anchored fact', '--cwd', target, '--body', 'auth backend', '--source', 'test']);
  const entries = await readdir(joinPath(target, '.memspec', 'memory', 'facts'));
  const id = entries[0].replace(/\.md$/, '');
  await runCli(['anchor', id, 'auth.py', '--cwd', target]);

  const result = await runCli(['context', '--cwd', target]);
  assert.match(result.stdout, /\[agent\] ⚓: Anchored fact/);
});

test('context --format json emits an array of items', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target, '--no-install-hooks']);
  await runCli(['add', 'fact', 'Item one', '--cwd', target, '--body', 'Body one', '--source', 'test']);

  const result = await runCli(['context', '--cwd', target, '--format', 'json']);
  const parsed = JSON.parse(result.stdout);
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].title, 'Item one');
  assert.equal(parsed[0].type, 'fact');
});

test('context --format json on empty store returns []', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target, '--no-install-hooks']);

  const result = await runCli(['context', '--cwd', target, '--format', 'json']);
  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(parsed, []);
});

test('context --limit caps the number of items emitted', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target, '--no-install-hooks']);
  for (let i = 0; i < 5; i++) {
    await runCli([
      'add', 'fact', `Fact ${i}`,
      '--cwd', target,
      '--body', `body ${i}`,
      '--source', 'test',
    ]);
  }

  const result = await runCli(['context', '--cwd', target, '--limit', '2', '--format', 'json']);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.length, 2);
});

test('context respects --budget (tight budget drops items)', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target, '--no-install-hooks']);
  // Each item body is ~80 chars; with budget=30 tokens (~120 chars) only
  // a small handful should fit.
  const longBody = 'x'.repeat(300);
  for (let i = 0; i < 10; i++) {
    await runCli([
      'add', 'fact', `Long fact ${i}`,
      '--cwd', target,
      '--body', longBody,
      '--source', 'test',
    ]);
  }

  const result = await runCli(['context', '--cwd', target, '--budget', '50', '--format', 'json']);
  const parsed = JSON.parse(result.stdout);
  assert.ok(parsed.length < 10, `expected fewer than 10 items, got ${parsed.length}`);
  assert.ok(parsed.length >= 1, 'expected at least 1 item to fit');
});

test('context --type filters by memory type', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target, '--no-install-hooks']);
  await runCli(['add', 'fact', 'A fact', '--cwd', target, '--body', 'fact body', '--source', 'test']);
  await runCli(['add', 'decision', 'A decision', '--cwd', target, '--body', 'decision body', '--source', 'test']);

  const result = await runCli(['context', '--cwd', target, '--type', 'decision', '--format', 'json']);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].type, 'decision');
});

test('context --query routes through store.search', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target, '--no-install-hooks']);
  await runCli(['add', 'fact', 'JWT auth tokens', '--cwd', target, '--body', 'JWT details', '--source', 'test']);
  await runCli(['add', 'fact', 'Database is Postgres', '--cwd', target, '--body', 'Postgres 16', '--source', 'test']);

  const result = await runCli(['context', '--cwd', target, '--query', 'JWT']);
  assert.match(result.stdout, /JWT auth tokens/);
  assert.doesNotMatch(result.stdout, /Postgres/);
});

test('context truncates very long bodies in markdown output', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target, '--no-install-hooks']);
  const longBody = 'x'.repeat(500);
  await runCli(['add', 'fact', 'Long body', '--cwd', target, '--body', longBody, '--source', 'test']);

  const result = await runCli(['context', '--cwd', target]);
  // The truncation indicator should be present and the full 500-char body
  // should NOT appear verbatim.
  assert.ok(!result.stdout.includes('x'.repeat(500)), 'full body should not appear verbatim');
  assert.match(result.stdout, /…/);
});

test('context surfaces pinned claims in a Pinned section above the working set', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target, '--no-install-hooks']);
  await runCli(['remember', 'fact', 'Ordinary fact', '--cwd', target, '--body', 'just a fact', '--source', 'test']);
  await runCli(['remember', 'decision', 'Identity decision', '--cwd', target, '--body', 'locked in', '--source', 'human:siim', '--pin']);

  const result = await runCli(['context', '--cwd', target]);
  const pinnedIdx = result.stdout.indexOf('### Pinned');
  const workingIdx = result.stdout.indexOf('### Working set');
  assert.ok(pinnedIdx !== -1, 'expected a Pinned section');
  assert.ok(workingIdx !== -1, 'expected a Working set section');
  assert.ok(pinnedIdx < workingIdx, 'Pinned renders above the working set');
  // The pinned claim lives in the Pinned section, not the working set.
  const pinnedBlock = result.stdout.slice(pinnedIdx, workingIdx);
  assert.match(pinnedBlock, /Identity decision/);
  assert.match(result.stdout.slice(workingIdx), /Ordinary fact/);
});

test('context caps the Pinned section at 5', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target, '--no-install-hooks']);
  for (let i = 0; i < 6; i++) {
    await runCli(['remember', 'fact', `Pinned ${i}`, '--cwd', target, '--body', `pin body ${i}`, '--source', 'human:siim', '--pin']);
  }

  const result = await runCli(['context', '--cwd', target]);
  const pinnedIdx = result.stdout.indexOf('### Pinned');
  const workingIdx = result.stdout.indexOf('### Working set');
  assert.ok(pinnedIdx !== -1 && workingIdx !== -1 && pinnedIdx < workingIdx);
  const pinnedBlock = result.stdout.slice(pinnedIdx, workingIdx);
  const pinnedLines = pinnedBlock.split('\n').filter((l) => l.startsWith('- '));
  assert.equal(pinnedLines.length, 5, 'Pinned section capped at 5');
  // The sixth pin overflows into the working set rather than vanishing.
  const workingLines = result.stdout.slice(workingIdx).split('\n').filter((l) => l.startsWith('- '));
  assert.equal(workingLines.length, 1);
});

test('context flags stale claims in a Needs attention section', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target, '--no-install-hooks']);
  await runCli(['remember', 'fact', 'Fresh fact', '--cwd', target, '--body', 'still good', '--source', 'test']);
  await runCli(['remember', 'fact', 'Old port', '--cwd', target, '--body', 'listens on 7779', '--source', 'test', '--check-by', '2000-01-01T00:00:00.000Z']);

  const result = await runCli(['context', '--cwd', target]);
  assert.match(result.stdout, /## Project memory — 2 active claims, 1 need attention/);
  const attentionIdx = result.stdout.indexOf('### Needs attention');
  assert.ok(attentionIdx !== -1, 'expected a Needs attention section');
  const line = result.stdout.split('\n').find((l) => l.includes('Old port'));
  assert.ok(line, 'stale claim line present');
  assert.match(line!, /⚠ check-by passed \d+d ago — "Old port" → verify \| supersede$/);
  // Stale claims do not repeat in the working set.
  assert.equal(result.stdout.split('Old port').length - 1, 1);
});

test('context flags drifted anchors with the anchor action', async () => {
  const { writeFile } = await import('node:fs/promises');
  const { readdir } = await import('node:fs/promises');
  const { join: joinPath } = await import('node:path');
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target, '--no-install-hooks']);
  await writeFile(joinPath(target, 'auth.py'), 'argon2id\n');
  await runCli(['remember', 'fact', 'Anchored auth fact', '--cwd', target, '--body', 'auth backend', '--source', 'test', '--anchor', 'auth.py']);
  await writeFile(joinPath(target, 'auth.py'), 'bcrypt\n'); // drift

  const result = await runCli(['context', '--cwd', target]);
  assert.match(result.stdout, /### Needs attention/);
  const line = result.stdout.split('\n').find((l) => l.includes('Anchored auth fact'));
  assert.ok(line, 'drifted claim line present');
  assert.match(line!, /⚠ anchor drift: auth\.py — "Anchored auth fact" → verify \| supersede \| anchor$/);
});

test('context caps Needs attention at 3 and overflow shows the stale marker in the working set', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target, '--no-install-hooks']);
  for (let i = 0; i < 4; i++) {
    await runCli(['remember', 'fact', `Stale ${i}`, '--cwd', target, '--body', `stale body ${i}`, '--source', 'test', '--check-by', `200${i}-01-01T00:00:00.000Z`]);
  }

  const result = await runCli(['context', '--cwd', target]);
  assert.match(result.stdout, /4 need attention/);
  const attentionLines = result.stdout.split('\n').filter((l) => l.includes('→ verify | supersede'));
  assert.equal(attentionLines.length, 3, 'attention section capped at 3');
  // The fourth stale claim falls through to the working set carrying ⚠.
  const overflow = result.stdout.split('\n').find((l) => l.includes('[agent] ⚠:'));
  assert.ok(overflow, 'overflow stale claim carries the ⚠ witness marker in the working set');
});

test('context spends pinned and needs-attention from the shared budget', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target, '--no-install-hooks']);
  const longBody = 'x'.repeat(300);
  await runCli(['remember', 'fact', 'Stale heavy', '--cwd', target, '--body', longBody, '--source', 'test', '--check-by', '2000-01-01T00:00:00.000Z']);
  await runCli(['remember', 'decision', 'Pinned heavy', '--cwd', target, '--body', longBody, '--source', 'human:siim', '--pin']);
  for (let i = 0; i < 8; i++) {
    await runCli(['remember', 'fact', `Filler ${i}`, '--cwd', target, '--body', longBody, '--source', 'test']);
  }

  // Budget fits roughly the attention line plus the pinned line and little else.
  const result = await runCli(['context', '--cwd', target, '--budget', '120']);
  assert.match(result.stdout, /Stale heavy/);
  assert.match(result.stdout, /Pinned heavy/);
  const fillerCount = result.stdout.split('\n').filter((l) => l.includes('Filler')).length;
  assert.ok(fillerCount < 8, `working set trimmed by the shared budget, got ${fillerCount} fillers`);
});

test('context returns empty section when store does not exist', async () => {
  const target = await makeTempProject();
  // No init — the .memspec dir does not exist.

  const result = await runCli(['context', '--cwd', target]);
  assert.match(result.stdout, /## Active project memory/);
  assert.match(result.stdout, /No active memories/);
});
