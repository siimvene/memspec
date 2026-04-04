import test from 'node:test';
import assert from 'node:assert/strict';
import { access, cp, readdir, writeFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempProject, readText, REPO_ROOT, runCli } from './helpers.js';

test('init creates the memspec directory tree and default config', async () => {
  const target = await makeTempProject();

  await runCli(['init', '--cwd', target]);

  await access(join(target, '.memspec', 'observations'));
  await access(join(target, '.memspec', 'memory', 'facts'));
  await access(join(target, '.memspec', 'memory', 'decisions'));
  await access(join(target, '.memspec', 'memory', 'procedures'));
  await access(join(target, '.memspec', 'archive'));

  const config = await readText(join(target, '.memspec', 'config.yaml'));
  assert.match(config, /profiles:/);
  assert.match(config, /fact: 90d/);
  assert.match(config, /decision: 180d/);
  assert.match(config, /procedure: 90d/);
});

test('init imports existing OpenClaw memory and patches AGENTS.md without duplicating on rerun', async () => {
  const target = await makeTempProject();

  await cp(join(REPO_ROOT, 'test', 'fixtures', 'openclaw-memory'), target, { recursive: true });
  await mkdir(join(target, 'memory', 'procedures'), { recursive: true });
  await writeFile(join(target, 'AGENTS.md'), '# Agent Notes\n\nExisting guidance.\n', 'utf8');

  const first = await runCli(['init', '--cwd', target]);

  const facts = await readdir(join(target, '.memspec', 'memory', 'facts'));
  const decisions = await readdir(join(target, '.memspec', 'memory', 'decisions'));
  const procedures = await readdir(join(target, '.memspec', 'memory', 'procedures'));
  const observations = await readdir(join(target, '.memspec', 'observations'));
  assert.equal(facts.length, 4);
  assert.equal(decisions.length, 2);
  assert.equal(procedures.length, 1);
  assert.equal(observations.length, 2);

  const agentsOnce = await readText(join(target, 'AGENTS.md'));
  assert.match(agentsOnce, /## Memory \(Memspec\)/);
  assert.match(agentsOnce, /Before answering questions about prior work/);
  assert.match(first.stdout, /Imported: 4 facts, 2 decisions, 1 procedures, 2 observations/);
  assert.match(first.stdout, /Patched .*AGENTS\.md with memspec instructions/);

  const second = await runCli(['init', '--cwd', target]);

  const factsAfterRerun = await readdir(join(target, '.memspec', 'memory', 'facts'));
  const decisionsAfterRerun = await readdir(join(target, '.memspec', 'memory', 'decisions'));
  const proceduresAfterRerun = await readdir(join(target, '.memspec', 'memory', 'procedures'));
  const observationsAfterRerun = await readdir(join(target, '.memspec', 'observations'));
  assert.equal(factsAfterRerun.length, 4);
  assert.equal(decisionsAfterRerun.length, 2);
  assert.equal(proceduresAfterRerun.length, 1);
  assert.equal(observationsAfterRerun.length, 2);

  const agentsTwice = await readText(join(target, 'AGENTS.md'));
  assert.equal((agentsTwice.match(/## Memory \(Memspec\)/g) ?? []).length, 1);
  assert.match(second.stdout, /Skipped brownfield import because the memspec store already contains items/);
});

test('init creates AGENTS.md with memspec instructions when no agent file exists', async () => {
  const target = await makeTempProject();

  await runCli(['init', '--cwd', target]);

  const agents = await readText(join(target, 'AGENTS.md'));
  assert.match(agents, /## Memory \(Memspec\)/);
  assert.match(agents, /This project uses Memspec for structured memory/);
});
