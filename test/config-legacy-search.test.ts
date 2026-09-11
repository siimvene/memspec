import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempProject, runCli } from './helpers.js';

test('legacy `search:` config block is ignored with a one-line stderr warning, not thrown', async () => {
  const target = await makeTempProject();

  await runCli(['init', '--cwd', target, '--no-interactive', '--no-install-hooks']);

  // Simulate a deployed store carrying the pre-0.11 hybrid-search config block.
  await appendFile(
    join(target, '.memspec', 'config.yaml'),
    '\nsearch:\n  engine: hybrid\n  embeddings:\n    provider: openai\n',
    'utf8',
  );

  const result = await runCli(['search', 'anything', '--cwd', target]);

  assert.match(
    result.stderr,
    /memspec: config `search:` block is ignored \(hybrid retrieval was removed in 0\.11\)/,
  );
  // Exactly one warning line for the single command invocation (one process).
  const warnings = result.stderr
    .split('\n')
    .filter((line) => line.includes('config `search:` block is ignored'));
  assert.equal(warnings.length, 1);
});
