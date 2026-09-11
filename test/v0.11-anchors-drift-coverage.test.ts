import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempProject, runCli } from './helpers.js';

async function lastId(project: string, type: 'facts' | 'decisions' | 'procedures'): Promise<string> {
  const dir = join(project, '.memspec', 'memory', type);
  const entries = (await readdir(dir)).filter((e) => e.endsWith('.md')).sort();
  return entries[entries.length - 1].replace(/\.md$/, '');
}

async function readFact(project: string, id: string): Promise<string> {
  return readFile(join(project, '.memspec', 'memory', 'facts', `${id}.md`), 'utf8');
}

// --- DEFECT A: write-side anchor resolution -------------------------------

test('absolute-path anchor to a sibling repo round-trips through remember → verify', async () => {
  const base = await makeTempProject();
  const project = join(base, 'project');
  const sibling = join(base, 'other-service');
  await mkdir(project, { recursive: true });
  await mkdir(join(sibling, '.git'), { recursive: true });
  await mkdir(join(sibling, 'src'), { recursive: true });
  await writeFile(join(sibling, 'src', 'auth.ts'), 'export const hash = "argon2id";\n');

  await runCli(['init', '--cwd', project]);
  const rem = await runCli([
    'remember', 'fact', 'Auth uses argon2id', '--cwd', project,
    '--body', 'password hashing', '--source', 'test',
    '--anchor', join(sibling, 'src', 'auth.ts'),
  ]);
  assert.match(rem.stdout, /Anchored to 1 file/);
  assert.match(rem.stdout, /src\/auth\.ts/);

  const id = await lastId(project, 'facts');
  const raw = await readFact(project, id);
  assert.match(raw, /repo: other-service/);
  assert.match(raw, /file: src\/auth\.ts/);
  assert.match(raw, /verified_with: anchor/);

  const v = await runCli(['verify', id, '--cwd', project]);
  assert.match(v.stdout, /Verified/);
  assert.match(v.stdout, /1 anchor\(s\) unchanged/);
});

test('relative anchor with --anchor-root resolves against the named checkout', async () => {
  const base = await makeTempProject();
  const project = join(base, 'project');
  const lib = join(base, 'lib-repo');
  await mkdir(project, { recursive: true });
  await mkdir(join(lib, '.git'), { recursive: true });
  await writeFile(join(lib, 'index.ts'), 'export const v = 1;\n');

  await runCli(['init', '--cwd', project]);
  const rem = await runCli([
    'remember', 'fact', 'Lib exports v', '--cwd', project,
    '--body', 'entry point', '--source', 'test',
    '--anchor', 'index.ts', '--anchor-root', lib,
  ]);
  assert.match(rem.stdout, /Anchored to 1 file/);

  const id = await lastId(project, 'facts');
  const raw = await readFact(project, id);
  assert.match(raw, /repo: lib-repo/);
  assert.match(raw, /file: index\.ts/);

  const v = await runCli(['verify', id, '--cwd', project]);
  assert.match(v.stdout, /1 anchor\(s\) unchanged/);
});

test('an unresolvable anchor warns actionably and still writes the claim as assertion', async () => {
  const project = await makeTempProject();
  await runCli(['init', '--cwd', project]);
  const rem = await runCli([
    'remember', 'fact', 'Unanchorable claim', '--cwd', project,
    '--body', 'x', '--source', 'test', '--anchor', 'nope.ts',
  ]);
  assert.match(rem.stdout, /Skipped nope\.ts: not found under/);
  assert.match(rem.stdout, /pass an absolute path or anchor_root/);

  const id = await lastId(project, 'facts');
  const raw = await readFact(project, id);
  assert.match(raw, /verified_with: assertion/);
  assert.doesNotMatch(raw, /anchors:/);
});

// --- DEFECT B: read-path drift -------------------------------------------

test('search JSON carries drifted; it flips on edit and clears on re-anchor', async () => {
  const project = await makeTempProject();
  await runCli(['init', '--cwd', project]);
  await writeFile(join(project, 'engine.ts'), 'export const e = 1;\n');
  await runCli([
    'remember', 'fact', 'Engine constant', '--cwd', project,
    '--body', 'engine exports e', '--source', 'test', '--anchor', 'engine.ts',
  ]);
  const id = await lastId(project, 'facts');

  const before = JSON.parse((await runCli(['search', 'engine constant', '--cwd', project, '--json'])).stdout);
  assert.equal(before[0].id, id);
  assert.equal(before[0].drifted, false);

  await writeFile(join(project, 'engine.ts'), 'export const e = 2; // changed\n');
  const after = JSON.parse((await runCli(['search', 'engine constant', '--cwd', project, '--json'])).stdout);
  assert.equal(after[0].drifted, true);
  assert.deepEqual(after[0].drift, [{ file: 'engine.ts', status: 'changed' }]);

  await runCli(['anchor', id, 'engine.ts', '--cwd', project]);
  const reanchored = JSON.parse((await runCli(['search', 'engine constant', '--cwd', project, '--json'])).stdout);
  assert.equal(reanchored[0].drifted, false);
});

test('drifted marker prints in the CLI text search output', async () => {
  const project = await makeTempProject();
  await runCli(['init', '--cwd', project]);
  await writeFile(join(project, 'router.ts'), 'export const routes = [];\n');
  await runCli([
    'remember', 'fact', 'Router table', '--cwd', project,
    '--body', 'router exports routes', '--source', 'test', '--anchor', 'router.ts',
  ]);
  await writeFile(join(project, 'router.ts'), 'export const routes = ["/"];\n');
  const out = await runCli(['search', 'router table', '--cwd', project]);
  assert.match(out.stdout, /\[DRIFTED/);
});

test('a cross-repo anchor whose repo is not checked out reads as anchor_unchecked, not drifted', async () => {
  const project = await makeTempProject();
  await runCli(['init', '--cwd', project]);
  await runCli(['remember', 'fact', 'Cross repo claim', '--cwd', project, '--body', 'x', '--source', 'test']);
  const id = await lastId(project, 'facts');
  // Hand-write a repo-qualified anchor to a repo that does not exist here.
  const path = join(project, '.memspec', 'memory', 'facts', `${id}.md`);
  const raw = await readFact(project, id);
  const withAnchor = raw.replace(
    /^verified_with: .*$/m,
    'verified_with: anchor\nanchors:\n  - file: src/x.ts\n    sha: deadbeef\n    repo: ghost-service',
  );
  await writeFile(path, withAnchor);
  const res = JSON.parse((await runCli(['search', 'cross repo claim', '--cwd', project, '--json'])).stdout);
  assert.equal(res[0].drifted, false);
  assert.equal(res[0].anchor_unchecked, true);
});

// --- DEFECT C: coverage disclosure ---------------------------------------

test('coverage reports none / weak / ok deterministically', async () => {
  const project = await makeTempProject();
  await runCli(['init', '--cwd', project]);
  await runCli([
    'remember', 'fact', 'Postgres ledger storage', '--cwd', project,
    '--body', 'The ledger stores double-entry rows in Postgres', '--source', 'test', '--tags', 'db',
  ]);
  await runCli([
    'remember', 'decision', 'Retry webhooks', '--cwd', project,
    '--body', 'Exponential backoff on delivery failure', '--source', 'test', '--tags', 'kleidia',
  ]);

  const none = await runCli(['search', 'kubernetes helm chart', '--cwd', project]);
  assert.match(none.stdout, /Coverage: none/);
  assert.match(none.stdout, /no active record matches this query/);

  // "kleidia" hits only the decision's tag; its title and body carry no such
  // token, so it is a title/tag-only match → weak.
  const weak = await runCli(['search', 'kleidia', '--cwd', project]);
  assert.match(weak.stdout, /Coverage: weak/);
  assert.match(weak.stdout, /do not infer from rank/);

  const ok = await runCli(['search', 'ledger postgres', '--cwd', project]);
  assert.match(ok.stdout, /Coverage: ok/);
});

test('coverage flags a partial-term match as weak and names the unmatched terms', async () => {
  const project = await makeTempProject();
  await runCli(['init', '--cwd', project]);
  await runCli([
    'remember', 'fact', 'Water tariff split', '--cwd', project,
    '--body', 'Water tariffs are stable around 2.10 per unit', '--source', 'test',
  ]);
  // Only "tariff" of the four terms occurs anywhere; the record still surfaces
  // via the FTS OR-fallback, but 1 of 4 < 0.5 → weak.
  const weak = await runCli(['search', 'zebra quantum flamingo tariff', '--cwd', project]);
  assert.match(weak.stdout, /Coverage: weak/);
  assert.match(weak.stdout, /1 of 4 query terms matched \(unmatched: zebra, quantum, flamingo\)/);
});

test('coverage stays ok when every term of a normal query matches', async () => {
  const project = await makeTempProject();
  await runCli(['init', '--cwd', project]);
  await runCli([
    'remember', 'fact', 'Postgres ledger storage', '--cwd', project,
    '--body', 'The ledger stores rows in Postgres', '--source', 'test',
  ]);
  const ok = await runCli(['search', 'postgres ledger', '--cwd', project]);
  assert.match(ok.stdout, /Coverage: ok/);
});

test('read-path drift agrees with reconcile for a home-rooted store with a repo-qualified anchor', async () => {
  const home = await makeTempProject(); // stands in for $HOME
  const repo = join(home, 'git', 'analysis');
  await mkdir(repo, { recursive: true });
  await writeFile(join(repo, 'ESTATE.md'), '# estate\ninitial\n');

  await runCli(['init', '--cwd', home]);
  // Home-rooted config: cross-repo anchors resolve under <home>/git.
  await writeFile(
    join(home, '.memspec', 'config.yaml'),
    `anchors:\n  repo_search_paths:\n    - ${join(home, 'git')}\n`,
  );

  const rem = await runCli([
    'remember', 'procedure', 'Estate simulation flywheel', '--cwd', home,
    '--body', 'estate simulation runs locally', '--source', 'test',
    '--anchor', 'analysis/ESTATE.md',
  ]);
  assert.match(rem.stdout, /Anchored to 1 file/);
  const id = await lastId(home, 'procedures');
  const raw = await readFile(join(home, '.memspec', 'memory', 'procedures', `${id}.md`), 'utf8');
  assert.match(raw, /repo: analysis/);
  assert.match(raw, /file: ESTATE\.md/);

  const before = JSON.parse((await runCli(['search', 'estate simulation flywheel', '--cwd', home, '--json'])).stdout);
  const beforeRow = before.find((r: { id: string }) => r.id === id);
  assert.equal(beforeRow.drifted, false);
  assert.equal(beforeRow.anchor_unchecked, false);

  await writeFile(join(repo, 'ESTATE.md'), '# estate\nCHANGED CONTENT\n');
  const after = JSON.parse((await runCli(['search', 'estate simulation flywheel', '--cwd', home, '--json'])).stdout);
  const afterRow = after.find((r: { id: string }) => r.id === id);
  assert.equal(afterRow.drifted, true);
  assert.deepEqual(afterRow.drift, [{ file: 'ESTATE.md', status: 'changed' }]);
});

test('coverage_witness reports the strongest witness among hits (anchor beats assertion)', async () => {
  const project = await makeTempProject();
  await runCli(['init', '--cwd', project]);
  await writeFile(join(project, 'cache.ts'), 'export const ttl = 60;\n');
  await runCli([
    'remember', 'fact', 'Cache ttl policy', '--cwd', project,
    '--body', 'cache ttl is 60 seconds', '--source', 'test', '--anchor', 'cache.ts', '--tags', 'cache',
  ]);
  await runCli([
    'remember', 'fact', 'Cache eviction strategy', '--cwd', project,
    '--body', 'cache uses lru eviction', '--source', 'test', '--tags', 'cache',
  ]);

  const res = await runCli(['search', 'cache', '--cwd', project]);
  // Both records match; the anchored one outranks assertion for coverage_witness.
  assert.match(res.stdout, /best witness: anchor/);
});

// --- requires_human / derived echo on search hits ---

test('search JSON and CLI text echo requires_human on a procedure hit', async () => {
  const project = await makeTempProject();
  await runCli(['init', '--cwd', project]);
  await runCli([
    'remember', 'procedure', 'Rotate signing key search test', '--cwd', project,
    '--body', 'rotate the signing key', '--source', 'test',
    '--requires-human', 'approve console', 'confirm HSM',
  ]);

  const jsonRes = await runCli(['search', 'signing key', '--cwd', project, '--json']);
  const [hit] = JSON.parse(jsonRes.stdout);
  assert.deepEqual(hit.requires_human, ['approve console', 'confirm HSM']);

  const textRes = await runCli(['search', 'signing key', '--cwd', project]);
  assert.match(textRes.stdout, /requires human: approve console; confirm HSM/);
});

test('search JSON and CLI text omit requires_human when absent', async () => {
  const project = await makeTempProject();
  await runCli(['init', '--cwd', project]);
  await runCli([
    'remember', 'fact', 'Plain fact no human steps', '--cwd', project,
    '--body', 'nothing special', '--source', 'test',
  ]);

  const jsonRes = await runCli(['search', 'no human steps', '--cwd', project, '--json']);
  const [hit] = JSON.parse(jsonRes.stdout);
  assert.equal('requires_human' in hit, false);

  const textRes = await runCli(['search', 'no human steps', '--cwd', project]);
  assert.doesNotMatch(textRes.stdout, /requires human:/);
});

test('search JSON and CLI text mark a derived record (derived: true, "(derived)" tag)', async () => {
  const project = await makeTempProject();
  await runCli(['init', '--cwd', project]);
  const basisRes = await runCli([
    'remember', 'fact', 'Derived-echo basis', '--cwd', project,
    '--body', 'basis body', '--source', 'test',
  ]);
  const basisId = basisRes.stdout.match(/ms_[0-9A-Z]+/)?.[0];
  assert.ok(basisId, `expected a memory id in remember output, got: ${basisRes.stdout}`);
  await runCli([
    'remember', 'fact', 'Derived echo conclusion', '--cwd', project,
    '--body', 'inferred conclusion', '--source', 'test', '--derived-from', basisId!,
  ]);

  const jsonRes = await runCli(['search', 'Derived echo conclusion', '--cwd', project, '--json']);
  const [hit] = JSON.parse(jsonRes.stdout);
  assert.equal(hit.derived, true);

  const textRes = await runCli(['search', 'Derived echo conclusion', '--cwd', project]);
  assert.match(textRes.stdout, /Derived echo conclusion \(assertion\) \(derived\)/);
});

test('search JSON and CLI text omit derived when the record carries no derived_from edge', async () => {
  const project = await makeTempProject();
  await runCli(['init', '--cwd', project]);
  await runCli([
    'remember', 'fact', 'Not derived at all', '--cwd', project,
    '--body', 'observed directly', '--source', 'test',
  ]);

  const jsonRes = await runCli(['search', 'Not derived at all', '--cwd', project, '--json']);
  const [hit] = JSON.parse(jsonRes.stdout);
  assert.equal('derived' in hit, false);

  const textRes = await runCli(['search', 'Not derived at all', '--cwd', project]);
  assert.doesNotMatch(textRes.stdout, /\(derived\)/);
});

// --- coverage_witness tier-down for derived records ---

test('coverage_witness counts a derived record one tier weaker (evidence -> assertion)', async () => {
  const project = await makeTempProject();
  await runCli(['init', '--cwd', project]);
  const basisRes = await runCli([
    'remember', 'fact', 'Tier-down basis', '--cwd', project,
    '--body', 'basis body', '--source', 'test',
  ]);
  const basisId = basisRes.stdout.match(/ms_[0-9A-Z]+/)?.[0];
  assert.ok(basisId);

  const proof = join(project, 'tier-down-proof.txt');
  await writeFile(proof, 'evidence for tier-down test');
  await runCli([
    'remember', 'fact', 'Tier-down derived evidence fact', '--cwd', project,
    '--body', 'inferred conclusion, evidence-backed', '--source', 'test',
    '--derived-from', basisId!, '--evidence', proof,
  ]);

  const res = await runCli(['search', 'Tier-down derived evidence', '--cwd', project, '--json']);
  const [hit] = JSON.parse(res.stdout);
  assert.equal(hit.derived, true);
  assert.equal(hit.verified_with, 'evidence'); // the record's own witness is unaffected

  const textRes = await runCli(['search', 'Tier-down derived evidence', '--cwd', project]);
  // coverage_witness is tiered down one step from evidence -> assertion
  assert.match(textRes.stdout, /best witness: assertion/);
});

test('coverage_witness leaves a derived, assertion-witnessed record at assertion (already the floor)', async () => {
  const project = await makeTempProject();
  await runCli(['init', '--cwd', project]);
  const basisRes = await runCli([
    'remember', 'fact', 'Tier-floor basis', '--cwd', project,
    '--body', 'basis body', '--source', 'test',
  ]);
  const basisId = basisRes.stdout.match(/ms_[0-9A-Z]+/)?.[0];
  assert.ok(basisId);
  await runCli([
    'remember', 'fact', 'Tier-floor derived assertion fact', '--cwd', project,
    '--body', 'inferred conclusion, unwitnessed', '--source', 'test', '--derived-from', basisId!,
  ]);

  const textRes = await runCli(['search', 'Tier-floor derived assertion', '--cwd', project]);
  assert.match(textRes.stdout, /best witness: assertion/);
});
