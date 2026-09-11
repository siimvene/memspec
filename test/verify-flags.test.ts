import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import matter from 'gray-matter';
import { makeTempProject, readText, REPO_ROOT, runCli } from './helpers.js';
import { McpSession } from './mcp-session.js';

/**
 * F4 — verify flags (`--check-by`) and non-interactive sweep (`--answers`).
 */

async function addFact(target: string, title: string): Promise<string> {
  await runCli(['remember', 'fact', title, '--cwd', target, '--body', 'Body text', '--source', 'test']);
  const factsDir = join(target, '.memspec', 'memory', 'facts');
  const entries = await readdir(factsDir);
  return entries[entries.length - 1].replace(/\.md$/, '');
}

test('verify --check-by never pins check_by explicitly on a clean verification', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  const id = await addFact(target, 'Identity-shaped fact');
  const factPath = join(target, '.memspec', 'memory', 'facts', `${id}.md`);

  const result = await runCli(['verify', id, '--cwd', target, '--evidence', 'checked manually', '--check-by', 'never']);
  assert.match(result.stdout, /Verified/);

  const after = matter(await readText(factPath)).data;
  assert.equal(after.check_by, 'never');
});

test('verify --check-by <iso> sets check_by to that exact timestamp', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  const id = await addFact(target, 'Custom TTL fact');
  const factPath = join(target, '.memspec', 'memory', 'facts', `${id}.md`);

  const explicit = '2030-01-01T00:00:00.000Z';
  await runCli(['verify', id, '--cwd', target, '--evidence', 'checked manually', '--check-by', explicit]);

  const after = matter(await readText(factPath)).data;
  assert.equal(after.check_by, explicit);
});

test('verify --check-by is ignored on a needs_review result (nothing is mutated)', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  await writeFile(join(target, 'auth.py'), 'mockup\n');
  const id = await addFact(target, 'Auth is a mockup');
  await runCli(['anchor', id, 'auth.py', '--cwd', target]);
  const factPath = join(target, '.memspec', 'memory', 'facts', `${id}.md`);
  const before = await readText(factPath);

  await writeFile(join(target, 'auth.py'), 'changed content\n');

  await assert.rejects(() => runCli(['verify', id, '--cwd', target, '--check-by', 'never']));

  const after = await readText(factPath);
  assert.equal(after, before, 'needs_review must not mutate the memory file even with --check-by set');
});

test('verify rejects an invalid --check-by value', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  const id = await addFact(target, 'Plain fact');

  await assert.rejects(
    () => runCli(['verify', id, '--cwd', target, '--evidence', 'checked', '--check-by', 'not-a-date']),
    (error: Error & { stderr?: string }) => {
      assert.match(`${error.message}\n${error.stderr ?? ''}`, /--check-by must be "never" or a valid ISO 8601 timestamp/);
      return true;
    },
  );
});

test('MCP memspec_verify accepts check_by and pins it on the record', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  const id = await addFact(target, 'MCP-verified fact');
  const factPath = join(target, '.memspec', 'memory', 'facts', `${id}.md`);

  const session = new McpSession([join(REPO_ROOT, 'src/mcp.ts'), '--cwd', target]);
  try {
    await session.request('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'memspec-test', version: '0.0.0' },
    });
    session.notify('notifications/initialized', {});
    const res = await session.request('tools/call', {
      name: 'memspec_verify',
      arguments: { id, evidence: 'checked via mcp', check_by: 'never' },
    });
    assert.equal(res.error, undefined);
  } finally {
    await session.close();
  }

  const after = matter(await readText(factPath)).data;
  assert.equal(after.check_by, 'never');
});

test('sweep --answers retires only ids answered y, defaults missing ids to n', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);

  const idA = await addFact(target, 'Stale A');
  const idB = await addFact(target, 'Stale B');
  const idC = await addFact(target, 'Stale C');

  // Force all three into the past so they read as stale.
  const factsDir = join(target, '.memspec', 'memory', 'facts');
  for (const id of [idA, idB, idC]) {
    const factPath = join(factsDir, `${id}.md`);
    const raw = await readText(factPath);
    const overdue = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    await writeFile(factPath, raw.replace(/^check_by:.*$/m, `check_by: '${overdue}'`));
  }

  const workDir = await mkdtemp(join(tmpdir(), 'memspec-answers-'));
  const answersPath = join(workDir, 'answers.tsv');
  // idB is answered 'n' explicitly, idC is omitted entirely (defaults to n).
  await writeFile(answersPath, `${idA}\ty\n${idB}\tn\n`);

  const result = await runCli(['sweep', '--cwd', target, '--answers', answersPath]);
  assert.match(result.stdout, /Retired 1 of 3 stale item\(s\) \(3 reviewed\)/);

  const archiveDir = join(target, '.memspec', 'archive');
  const archived = await readdir(archiveDir);
  assert.equal(archived.length, 1);
  assert.ok(archived[0].includes(idA));

  // idB and idC remain active.
  const remaining = await readdir(factsDir);
  assert.equal(remaining.length, 2);
});

test('sweep --dry-run still lists candidates and ignores --answers', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  const id = await addFact(target, 'Stale for dry run');
  const factPath = join(target, '.memspec', 'memory', 'facts', `${id}.md`);
  const raw = await readText(factPath);
  const overdue = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  await writeFile(factPath, raw.replace(/^check_by:.*$/m, `check_by: '${overdue}'`));

  const result = await runCli(['sweep', '--cwd', target, '--dry-run']);
  assert.match(result.stdout, /1 stale item\(s\) eligible for retirement/);
  assert.match(result.stdout, /Dry run - no changes made/);

  const stillActive = await readdir(join(target, '.memspec', 'memory', 'facts'));
  assert.equal(stillActive.length, 1);
});
