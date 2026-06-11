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

  const facts = await readdir(factsDir);
  const decisions = await readdir(decisionsDir);
  const procedures = await readdir(proceduresDir);

  // v0.3 drops the captured state — old observations land as active claims of
  // their classified type. The fixture has one decision-typed observation and
  // one fact-typed observation, so each grows by one.
  assert.equal(facts.length, 5);
  assert.equal(decisions.length, 3);
  assert.equal(procedures.length, 1);

  const importedDecision = matter(await readText(join(decisionsDir, decisions[0])));
  assert.equal(importedDecision.data.type, 'decision');
  assert.equal(importedDecision.data.state, 'active');

  const importedFactBodies = await Promise.all(
    facts.map(async (entry) => matter(await readText(join(factsDir, entry)))),
  );
  assert.ok(importedFactBodies.some((item) => item.content.includes('LIVE on App Store')));
  assert.ok(importedFactBodies.some((item) => item.content.includes('[REDACTED]')));
  assert.ok(importedFactBodies.some((item) => /verification/i.test(item.content)));

  const status = await runCli(['status', '--cwd', target]);
  assert.match(status.stdout, /total\s+9/);

  const search = await runCli(['search', 'files over db', '--cwd', target, '--profile', 'default']);
  assert.match(search.stdout, /Memory files over DB/);
});
