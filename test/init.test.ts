import test from 'node:test';
import assert from 'node:assert/strict';
import { access, cp, mkdir, writeFile } from 'node:fs/promises';
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

test('init imports brownfield memory and patches AGENTS.md for agent use', async () => {
  const target = await makeTempProject();

  await cp(join(REPO_ROOT, 'test', 'fixtures', 'openclaw-memory'), target, { recursive: true });
  await mkdir(join(target, 'memory', 'procedures'), { recursive: true });
  await writeFile(
    join(target, 'AGENTS.md'),
    '# Existing Instructions\n\nKeep responses concise.\n',
    'utf8',
  );

  const result = await runCli(['init', '--cwd', target]);

  const factsDir = join(target, '.memspec', 'memory', 'facts');
  const decisionsDir = join(target, '.memspec', 'memory', 'decisions');
  const proceduresDir = join(target, '.memspec', 'memory', 'procedures');

  await access(factsDir);
  await access(decisionsDir);
  await access(proceduresDir);

  const status = await runCli(['status', '--cwd', target]);
  assert.match(status.stdout, /active\s+7/);
  assert.match(status.stdout, /captured\s+2/);

  const agents = await readText(join(target, 'AGENTS.md'));
  assert.match(agents, /# Existing Instructions/);
  assert.match(agents, /This repository uses Memspec for project memory/);
  assert.match(agents, /Search Memspec for relevant facts, decisions, and procedures/);

  assert.match(result.stdout, /Imported brownfield memory/);
  assert.match(result.stdout, /Patched AGENTS.md/);
});
