import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';
import { makeTempProject, readText, REPO_ROOT, runCli } from './helpers.js';

test('import-openclaw converts an OpenClaw memory bank into memspec items', async () => {
  const target = await makeTempProject();
  const source = join(target, 'workspace');

  await cp(join(REPO_ROOT, 'test', 'fixtures', 'openclaw-memory'), source, { recursive: true });

  await runCli([
    'import-openclaw',
    '--cwd',
    target,
    '--source',
    source,
  ]);

  const factsDir = join(target, '.memspec', 'memory', 'facts');
  const decisionsDir = join(target, '.memspec', 'memory', 'decisions');
  const proceduresDir = join(target, '.memspec', 'memory', 'procedures');
  const observationsDir = join(target, '.memspec', 'observations');

  const facts = await readdir(factsDir);
  const decisions = await readdir(decisionsDir);
  const procedures = await readdir(proceduresDir);
  const observations = await readdir(observationsDir);

  assert.equal(facts.length, 4);
  assert.equal(decisions.length, 2);
  assert.equal(procedures.length, 1);
  assert.equal(observations.length, 2);

  const importedDecision = matter(await readText(join(decisionsDir, decisions[0])));
  assert.equal(importedDecision.data.type, 'decision');
  assert.equal(importedDecision.data.state, 'active');

  const importedFactBodies = await Promise.all(
    facts.map(async (entry) => matter(await readText(join(factsDir, entry)))),
  );
  assert.ok(importedFactBodies.some((item) => item.content.includes('LIVE on App Store')));
  assert.ok(importedFactBodies.some((item) => item.content.includes('[REDACTED]')));

  const importedObservation = matter(await readText(join(observationsDir, observations[0])));
  assert.equal(importedObservation.data.state, 'captured');
  assert.match(importedObservation.content, /verification/i);

  const status = await runCli(['status', '--cwd', target]);
  assert.match(status.stdout, /active\s+7/);
  assert.match(status.stdout, /captured\s+2/);

  const search = await runCli(['search', 'files over db', '--cwd', target, '--profile', 'default']);
  assert.match(search.stdout, /Memory files over DB/);
});
