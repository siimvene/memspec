import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';
import { makeTempProject, runCli } from './helpers.js';

/**
 * F2 — scope enforcement (`scopes_require: true`). When a store opts in, a
 * `remember`/`observe` write that resolves NO scope is refused; `--scope
 * universal` remains the explicit opt-out.
 */

async function makeStoreWithScopesRequire(): Promise<string> {
  const project = await makeTempProject();
  await runCli(['init', '--cwd', project, '--no-interactive', '--no-install-hooks']);
  const configPath = join(project, '.memspec', 'config.yaml');
  const existing = await readFile(configPath, 'utf8');
  await writeFile(configPath, `${existing}\nscopes_require: true\n`, 'utf8');
  return project;
}

test('remember refuses an unscoped write when scopes_require is true', async () => {
  const target = await makeStoreWithScopesRequire();

  await assert.rejects(
    () => runCli(['remember', 'fact', 'Unscoped fact', '--cwd', target, '--source', 'test']),
    (error: Error & { stderr?: string }) => {
      const combined = `${error.message}\n${error.stderr ?? ''}`;
      assert.match(combined, /scope required/);
      assert.match(combined, /scopes_require/);
      return true;
    },
  );
});

test('remember succeeds when scopes_require is true and --scope is passed', async () => {
  const target = await makeStoreWithScopesRequire();
  const result = await runCli(['remember', 'fact', 'Scoped fact', '--cwd', target, '--source', 'test', '--scope', 'kleidia']);
  assert.match(result.stdout, /Created fact memory/);

  const factsDir = join(target, '.memspec', 'memory', 'facts');
  const { readdir } = await import('node:fs/promises');
  const [entry] = await readdir(factsDir);
  const data = matter(await readFile(join(factsDir, entry), 'utf8')).data;
  assert.equal(data.scope, 'kleidia');
});

test('remember succeeds when scopes_require is true and --scope universal is the explicit opt-out', async () => {
  const target = await makeStoreWithScopesRequire();
  const result = await runCli(['remember', 'fact', 'Universal fact', '--cwd', target, '--source', 'test', '--scope', 'universal']);
  assert.match(result.stdout, /Created fact memory/);

  const factsDir = join(target, '.memspec', 'memory', 'facts');
  const { readdir } = await import('node:fs/promises');
  const [entry] = await readdir(factsDir);
  const data = matter(await readFile(join(factsDir, entry), 'utf8')).data;
  assert.equal(data.scope, 'universal');
});

test('remember succeeds unscoped when scopes_require is left at its false default', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  const result = await runCli(['remember', 'fact', 'Fine to be unscoped', '--cwd', target, '--source', 'test']);
  assert.match(result.stdout, /Created fact memory/);
});

test('observe refuses an unscoped write when scopes_require is true, and accepts --scope', async () => {
  const target = await makeStoreWithScopesRequire();

  await assert.rejects(
    () => runCli(['observe', 'Something happened', '--cwd', target]),
    (error: Error & { stderr?: string }) => {
      assert.match(`${error.message}\n${error.stderr ?? ''}`, /scope required/);
      return true;
    },
  );

  const result = await runCli(['observe', 'Something happened, scoped', '--cwd', target, '--scope', 'kleidia']);
  assert.match(result.stdout, /Observed/);
});

test('remember refusal lists known scopes (declared config + scopes already in use)', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target, '--no-interactive', '--no-install-hooks']);
  const configPath = join(target, '.memspec', 'config.yaml');
  const existing = await readFile(configPath, 'utf8');
  await writeFile(configPath, `${existing}\nscopes_require: true\nscopes:\n  plg: ['/nowhere-matches']\n`, 'utf8');

  await assert.rejects(
    () => runCli(['remember', 'fact', 'Still unscoped', '--cwd', target, '--source', 'test']),
    (error: Error & { stderr?: string }) => {
      const combined = `${error.message}\n${error.stderr ?? ''}`;
      assert.match(combined, /known scopes:.*plg/);
      return true;
    },
  );
});
