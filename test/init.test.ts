import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempProject, readText, runCli } from './helpers.js';

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
