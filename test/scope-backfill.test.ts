import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import matter from 'gray-matter';
import { makeTempProject, runCli, REPO_ROOT } from './helpers.js';

const execFileAsync = promisify(execFile);
const SCRIPT = join(REPO_ROOT, 'bin', 'repair-scope-backfill.mjs');
const MAP = 'plg:plg,piletilevi:plg,kvart:kvart,kleidia:kleidia';

async function runBackfill(storeRoot: string, extraArgs: string[] = []): Promise<{ stdout: string }> {
  const args = [SCRIPT, '--store', storeRoot, '--map', MAP, ...extraArgs];
  return execFileAsync(process.execPath, args, { cwd: REPO_ROOT });
}

function record(id: string, opts: { tags: string[]; source?: string; state?: string }): string {
  return matter.stringify(
    '# Fixture record\n\nBody stays intact.',
    {
      id,
      kind: 'claim',
      type: 'fact',
      state: opts.state ?? 'active',
      created: '2026-08-01T00:00:00.000Z',
      source: opts.source ?? 'agent',
      tags: opts.tags,
      check_by: 'never',
    },
  );
}

test('scope backfill: dry-run counts matches, ambiguous, and unmatched; --apply writes scope', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  const storeRoot = join(target, '.memspec');
  const factsDir = join(storeRoot, 'memory', 'facts');
  await mkdir(factsDir, { recursive: true });

  const matchedId = 'ms_01SB0000000000000000000AAA';
  const matchedViaAliasId = 'ms_01SB0000000000000000000BBB';
  const ambiguousId = 'ms_01SB0000000000000000000CCC';
  const unmatchedId = 'ms_01SB0000000000000000000DDD';
  const alreadyScopedId = 'ms_01SB0000000000000000000EEE';
  const operatorId = 'ms_01SB0000000000000000000FFF';

  await writeFile(join(factsDir, `${matchedId}.md`), record(matchedId, { tags: ['plg'] }));
  await writeFile(join(factsDir, `${matchedViaAliasId}.md`), record(matchedViaAliasId, { tags: ['piletilevi'] }));
  await writeFile(join(factsDir, `${ambiguousId}.md`), record(ambiguousId, { tags: ['plg', 'kvart'] }));
  await writeFile(join(factsDir, `${unmatchedId}.md`), record(unmatchedId, { tags: ['unrelated-topic'] }));
  await writeFile(join(factsDir, `${operatorId}.md`), record(operatorId, { tags: ['kvart'], source: 'human:siim' }));

  // Already-scoped record must be left alone entirely.
  const alreadyScopedParsed = matter(record(alreadyScopedId, { tags: ['plg'] }));
  alreadyScopedParsed.data.scope = 'kleidia';
  await writeFile(join(factsDir, `${alreadyScopedId}.md`), matter.stringify(alreadyScopedParsed.content, alreadyScopedParsed.data));

  const dry = await runBackfill(storeRoot);
  assert.match(dry.stdout, /DRY-RUN/);
  assert.match(dry.stdout, /2 record\(s\) would be stamped with a scope/); // matchedId + matchedViaAliasId -> plg
  assert.match(dry.stdout, /plg: 2/);
  assert.match(dry.stdout, /1 record\(s\) ambiguous/);
  assert.match(dry.stdout, new RegExp(`${ambiguousId}: tags matched scopes`));
  assert.match(dry.stdout, /1 record\(s\) matched no map entry/);
  assert.match(dry.stdout, /1 operator-sourced record\(s\) SKIPPED/);

  // Dry run must not have written anything.
  const stillUnscoped = matter(await readFile(join(factsDir, `${matchedId}.md`), 'utf8')).data;
  assert.equal(stillUnscoped.scope, undefined);

  const applied = await runBackfill(storeRoot, ['--apply']);
  assert.match(applied.stdout, /APPLIED/);
  assert.match(applied.stdout, /undo journal written/);

  const matched = matter(await readFile(join(factsDir, `${matchedId}.md`), 'utf8')).data;
  assert.equal(matched.scope, 'plg');
  const matchedViaAlias = matter(await readFile(join(factsDir, `${matchedViaAliasId}.md`), 'utf8')).data;
  assert.equal(matchedViaAlias.scope, 'plg');
  const ambiguous = matter(await readFile(join(factsDir, `${ambiguousId}.md`), 'utf8')).data;
  assert.equal(ambiguous.scope, undefined, 'ambiguous records are left untouched');
  const unmatched = matter(await readFile(join(factsDir, `${unmatchedId}.md`), 'utf8')).data;
  assert.equal(unmatched.scope, undefined, 'unmatched records are left untouched');
  const operatorRecord = matter(await readFile(join(factsDir, `${operatorId}.md`), 'utf8')).data;
  assert.equal(operatorRecord.scope, undefined, 'operator records are skipped by default');
  const alreadyScoped = matter(await readFile(join(factsDir, `${alreadyScopedId}.md`), 'utf8')).data;
  assert.equal(alreadyScoped.scope, 'kleidia', 'a pre-existing scope is never overwritten');

  // Journal restores the pre-apply state.
  const files = await readdir(storeRoot);
  const journalFile = files.find((f) => f.startsWith('repair-scope-backfill.'));
  assert.ok(journalFile, 'expected an undo journal file');
  const journal = JSON.parse(await readFile(join(storeRoot, journalFile!), 'utf8'));
  assert.equal(journal.status, 'completed');
  assert.equal(journal.records_changed, 2);
});

test('scope backfill: --include-operator backfills operator-sourced records too', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  const storeRoot = join(target, '.memspec');
  const factsDir = join(storeRoot, 'memory', 'facts');
  await mkdir(factsDir, { recursive: true });

  const operatorId = 'ms_01SB0000000000000000000GGG';
  await writeFile(join(factsDir, `${operatorId}.md`), record(operatorId, { tags: ['kleidia'], source: 'human:siim' }));

  const dry = await runBackfill(storeRoot, ['--include-operator']);
  assert.match(dry.stdout, /1 record\(s\) would be stamped with a scope/);
  assert.doesNotMatch(dry.stdout, /operator-sourced record\(s\) SKIPPED/);

  await runBackfill(storeRoot, ['--include-operator', '--apply']);
  const data = matter(await readFile(join(factsDir, `${operatorId}.md`), 'utf8')).data;
  assert.equal(data.scope, 'kleidia');
});

test('scope backfill: refuses to run without --map', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  const storeRoot = join(target, '.memspec');

  await assert.rejects(() => execFileAsync(process.execPath, [SCRIPT, '--store', storeRoot], { cwd: REPO_ROOT }));
});
