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

  const before = JSON.parse((await runCli(['search', 'engine constant', '--cwd', project, '--json'])).stdout).results;
  assert.equal(before[0].id, id);
  assert.equal(before[0].drifted, false);

  await writeFile(join(project, 'engine.ts'), 'export const e = 2; // changed\n');
  const after = JSON.parse((await runCli(['search', 'engine constant', '--cwd', project, '--json'])).stdout).results;
  assert.equal(after[0].drifted, true);
  assert.deepEqual(after[0].drift, [{ file: 'engine.ts', status: 'changed' }]);

  await runCli(['anchor', id, 'engine.ts', '--cwd', project]);
  const reanchored = JSON.parse((await runCli(['search', 'engine constant', '--cwd', project, '--json'])).stdout).results;
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
  const res = JSON.parse((await runCli(['search', 'cross repo claim', '--cwd', project, '--json'])).stdout).results;
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

  const before = JSON.parse((await runCli(['search', 'estate simulation flywheel', '--cwd', home, '--json'])).stdout).results;
  const beforeRow = before.find((r: { id: string }) => r.id === id);
  assert.equal(beforeRow.drifted, false);
  assert.equal(beforeRow.anchor_unchecked, false);

  await writeFile(join(repo, 'ESTATE.md'), '# estate\nCHANGED CONTENT\n');
  const after = JSON.parse((await runCli(['search', 'estate simulation flywheel', '--cwd', home, '--json'])).stdout).results;
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
  const [hit] = JSON.parse(jsonRes.stdout).results;
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
  const [hit] = JSON.parse(jsonRes.stdout).results;
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
  const [hit] = JSON.parse(jsonRes.stdout).results;
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
  const [hit] = JSON.parse(jsonRes.stdout).results;
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
  const [hit] = JSON.parse(res.stdout).results;
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

// --- coverage: index-tokenised whole-token term test, stopwords, best-covered hit ---

test('coverage term test tokenises like the index: punctuation and quotes do not flip a full match to weak', async () => {
  const project = await makeTempProject();
  await runCli(['init', '--cwd', project]);
  await runCli([
    'remember', 'fact', 'Remootio gate relay', '--cwd', project,
    '--body', 'Remootio relay opens the gate; Hubitat driver polls status.', '--source', 'test',
  ]);

  const commas = await runCli(['search', 'remootio, hubitat, gate', '--cwd', project]);
  assert.match(commas.stdout, /Coverage: ok/);

  const quoted = await runCli(['search', '"remootio relay" hubitat', '--cwd', project]);
  assert.match(quoted.stdout, /Coverage: ok/);
});

test('coverage term test is whole-token: "gate" does not match inside "gateway"', async () => {
  const project = await makeTempProject();
  await runCli(['init', '--cwd', project]);
  await runCli([
    'remember', 'fact', 'Kvart gateway policy', '--cwd', project,
    '--body', 'the api gateway terminates tls at the edge', '--source', 'test',
  ]);
  const res = await runCli(['search', 'gate relay tls', '--cwd', project]);
  assert.match(res.stdout, /Coverage: weak/);
  assert.match(res.stdout, /1 of 3 query terms matched \(unmatched: gate, relay\)/);
});

test('coverage ignores function words: a natural-language question about an absent topic reads weak, not ok', async () => {
  const project = await makeTempProject();
  await runCli(['init', '--cwd', project]);
  await runCli([
    'remember', 'procedure', 'Kvart backup pull', '--cwd', project,
    '--body', 'does a nightly rsync of the kvart database; use with care.', '--source', 'test',
  ]);
  const keyword = await runCli(['search', 'kvart gateway mtls', '--cwd', project]);
  assert.match(keyword.stdout, /Coverage: weak/);

  const natural = await runCli(['search', 'does the kvart gateway use mtls', '--cwd', project]);
  assert.match(natural.stdout, /Coverage: weak/);
  assert.match(natural.stdout, /1 of 3 query terms matched \(unmatched: gateway, mtls\)/);
});

test('coverage is judged on the best-covered hit, not seeds[0]: a layered junk rank-1 hit does not mask the exact match', async () => {
  const personal = await makeTempProject();
  const team = await makeTempProject();
  await runCli(['init', '--cwd', personal, '--no-interactive', '--no-install-hooks']);
  await runCli(['init', '--cwd', team, '--no-interactive', '--no-install-hooks']);
  // Higher-priority writable layer holds a record sharing only the token "kvart".
  await runCli([
    'remember', 'procedure', 'Kvart backup pull', '--cwd', personal,
    '--body', 'does a nightly rsync of the kvart database', '--source', 'test',
  ]);
  // Lower-priority read-only layer holds the record carrying every term.
  await runCli([
    'remember', 'fact', 'Kvart gateway mTLS', '--cwd', team,
    '--body', 'the kvart gateway uses mtls via step-ca', '--source', 'team:eval',
  ]);
  await writeFile(join(personal, '.memspec', 'config.yaml'), [
    'stores:',
    '  - name: personal',
    `    path: ${join(personal, '.memspec')}`,
    '    priority: 10',
    '    writable: true',
    '  - name: team',
    `    path: ${join(team, '.memspec')}`,
    '    priority: 0',
    '    writable: false',
    '',
  ].join('\n'));

  const res = JSON.parse((await runCli(['search', 'kvart gateway mtls', '--cwd', personal, '--json'])).stdout);
  assert.equal(res.results.length, 2);
  assert.equal(res.coverage, 'ok', res.coverage_note);
});

test('coverage weak/ok notes name the active scope', async () => {
  const project = await makeTempProject();
  await runCli(['init', '--cwd', project, '--no-interactive', '--no-install-hooks']);
  await writeFile(join(project, '.memspec', 'config.yaml'), `scopes:\n  kvart: ['${join(project, 'kvart')}/**']\n`);
  await runCli([
    'remember', 'fact', 'Kvart invoices nightly', '--cwd', project,
    '--body', 'invoices are generated nightly', '--source', 'test', '--scope', 'kvart',
  ]);
  const ok = await runCli(['search', 'invoices nightly', '--cwd', project, '--scope', 'kvart']);
  assert.match(ok.stdout, /Coverage: ok — at least one genuine match in scope kvart/);

  const weak = await runCli(['search', 'invoices zebra flamingo', '--cwd', project, '--scope', 'kvart']);
  assert.match(weak.stdout, /1 of 3 query terms matched in scope kvart \(unmatched: zebra, flamingo\)/);
});

test('coverage_witness tiers a drifted anchor down to evidence and says so', async () => {
  const project = await makeTempProject();
  await runCli(['init', '--cwd', project]);
  await writeFile(join(project, 'drift-witness.ts'), 'export const a = 1;\n');
  await runCli([
    'remember', 'fact', 'Drift witness constant', '--cwd', project,
    '--body', 'drift witness exports a', '--source', 'test', '--anchor', 'drift-witness.ts',
  ]);
  const clean = await runCli(['search', 'drift witness constant', '--cwd', project]);
  assert.match(clean.stdout, /best witness: anchor\)/);

  await writeFile(join(project, 'drift-witness.ts'), 'export const a = 2;\n');
  const drifted = await runCli(['search', 'drift witness constant', '--cwd', project]);
  assert.match(drifted.stdout, /\[DRIFTED/);
  assert.match(drifted.stdout, /best witness: evidence \(drifted\)/);

  const json = JSON.parse((await runCli(['search', 'drift witness constant', '--cwd', project, '--json'])).stdout);
  assert.equal(json.coverage_witness, 'evidence');
  assert.equal(json.coverage_witness_note, 'drifted');
});

test('coverage_witness tiers an unchecked anchor (repo not checked out) down to evidence', async () => {
  const project = await makeTempProject();
  await runCli(['init', '--cwd', project]);
  await runCli(['remember', 'fact', 'Unchecked witness claim', '--cwd', project, '--body', 'x', '--source', 'test']);
  const id = await lastId(project, 'facts');
  const path = join(project, '.memspec', 'memory', 'facts', `${id}.md`);
  const raw = await readFact(project, id);
  await writeFile(path, raw.replace(
    /^verified_with: .*$/m,
    'verified_with: anchor\nanchors:\n  - file: src/x.ts\n    sha: deadbeef\n    repo: ghost-service',
  ));
  const res = await runCli(['search', 'unchecked witness claim', '--cwd', project]);
  assert.match(res.stdout, /best witness: evidence \(anchor unchecked\)/);
});

test('coverage none/weak notes name a narrowing type filter and count matches of other types', async () => {
  const project = await makeTempProject();
  await runCli(['init', '--cwd', project]);
  await runCli([
    'remember', 'decision', 'Use step-ca for mTLS', '--cwd', project,
    '--body', 'kvart gateway mtls via step-ca', '--source', 'test',
  ]);
  const none = await runCli(['search', 'kvart mtls', '--cwd', project, '--type', 'fact']);
  assert.match(none.stdout, /Coverage: none — no active fact record matches this query in scope any; 1 record\(s\) of other types match — retry without the type filter/);

  // The default profile's types cover every claim type: not a narrowing filter, not named.
  const plain = await runCli(['search', 'zebra flamingo', '--cwd', project]);
  assert.match(plain.stdout, /Coverage: none — no active record matches this query in scope any$/m);
});

// --- Panel remediation: #5 / #16 / #9 -------------------------------------

test('#5: an absolute anchor inside a HOME-rooted store but in another git repo is recorded as {repo, file}, not HOME-relative', async () => {
  const home = await makeTempProject(); // stands in for $HOME
  const repo = join(home, 'git', 'kvart');
  await mkdir(join(repo, '.git'), { recursive: true });
  await mkdir(join(repo, 'src'), { recursive: true });
  await writeFile(join(repo, 'src', 'x.ts'), 'export const a = 1;\n');
  await runCli(['init', '--cwd', home]);

  // No anchors.repo_search_paths configured: the ~/git default must carry it.
  const rem = await runCli([
    'remember', 'fact', 'Kvart x', '--cwd', repo, '--store', 'global', '--source', 'test',
    '--anchor', join(repo, 'src', 'x.ts'),
  ], undefined, { HOME: home });
  assert.match(rem.stdout, /Anchored to 1 file/);
  assert.doesNotMatch(rem.stdout, /recorded against repo/, 'default ~/git search path resolves it, so no warning');

  const id = await lastId(home, 'facts');
  const raw = await readFact(home, id);
  assert.match(raw, /repo: kvart/);
  assert.match(raw, /file: src\/x\.ts/);
  assert.doesNotMatch(raw, /file: git\/kvart/);

  // Read side agrees with no config: verify clean, search not drifted/unchecked.
  const v = await runCli(['verify', id, '--cwd', home], undefined, { HOME: home });
  assert.match(v.stdout, /1 anchor\(s\) unchanged/);
  const row = JSON.parse((await runCli(['search', 'Kvart x', '--cwd', home, '--json'], undefined, { HOME: home })).stdout).results
    .find((r: { id: string }) => r.id === id);
  assert.equal(row.drifted, false);
  assert.equal(row.anchor_unchecked, false);

  // And genuine drift is still detected through the {repo, file} form.
  await writeFile(join(repo, 'src', 'x.ts'), 'export const a = 2;\n');
  const after = JSON.parse((await runCli(['search', 'Kvart x', '--cwd', home, '--json'], undefined, { HOME: home })).stdout).results
    .find((r: { id: string }) => r.id === id);
  assert.equal(after.drifted, true);
});

test('#5: an absolute anchor inside the project\'s own repo stays repo-less and project-relative', async () => {
  const project = await makeTempProject();
  await mkdir(join(project, '.git'), { recursive: true });
  await mkdir(join(project, 'src'), { recursive: true });
  await writeFile(join(project, 'src', 'own.ts'), 'export const own = 1;\n');
  await runCli(['init', '--cwd', project]);
  await runCli(['remember', 'fact', 'Own file', '--cwd', project, '--source', 'test', '--anchor', join(project, 'src', 'own.ts')]);
  const raw = await readFact(project, await lastId(project, 'facts'));
  assert.match(raw, /file: src\/own\.ts/);
  assert.doesNotMatch(raw, /repo:/);
});

test('#16: anchor_root form on a HOME-rooted store round-trips through verify and search with no repo_search_paths configured', async () => {
  const home = await makeTempProject();
  const repo = join(home, 'git', 'kvart');
  await mkdir(join(repo, '.git'), { recursive: true });
  await mkdir(join(repo, 'src'), { recursive: true });
  await writeFile(join(repo, 'src', 'a.ts'), 'a\n');
  await runCli(['init', '--cwd', home]);

  const rem = await runCli([
    'remember', 'fact', 'Kvart a', '--cwd', home, '--source', 'test',
    '--anchor', 'src/a.ts', '--anchor-root', repo,
  ], undefined, { HOME: home });
  assert.match(rem.stdout, /Anchored to 1 file/);
  const id = await lastId(home, 'facts');
  assert.match(await readFact(home, id), /repo: kvart/);

  const v = await runCli(['verify', id, '--cwd', home], undefined, { HOME: home });
  assert.match(v.stdout, /Verified/);
  const row = JSON.parse((await runCli(['search', 'Kvart a', '--cwd', home, '--json'], undefined, { HOME: home })).stdout).results
    .find((r: { id: string }) => r.id === id);
  assert.equal(row.anchor_unchecked, false);
});

test('#16: a {repo, file} anchor this store cannot resolve on read is still written but warns with the directory to add', async () => {
  const base = await makeTempProject();
  const home = join(base, 'home');
  const checkouts = join(base, 'srv', 'checkouts');
  const elsewhere = join(checkouts, 'faraway');
  await mkdir(home, { recursive: true });
  await mkdir(join(elsewhere, '.git'), { recursive: true });
  await writeFile(join(elsewhere, 'f.ts'), 'f\n');
  await runCli(['init', '--cwd', home]);

  const rem = await runCli([
    'remember', 'fact', 'Faraway f', '--cwd', home, '--source', 'test',
    '--anchor', 'f.ts', '--anchor-root', elsewhere,
  ], undefined, { HOME: home });
  assert.match(rem.stdout, /Anchored to 1 file/);
  assert.match(rem.stdout, /recorded against repo faraway/);
  assert.ok(rem.stdout.includes(`add ${checkouts} to anchors.repo_search_paths`), rem.stdout);

  // Configure the named directory and the read side resolves it.
  await writeFile(join(home, '.memspec', 'config.yaml'), `anchors:\n  repo_search_paths:\n    - ${checkouts}\n`);
  const id = await lastId(home, 'facts');
  const v = await runCli(['verify', id, '--cwd', home], undefined, { HOME: home });
  assert.match(v.stdout, /1 anchor\(s\) unchanged/);
});

test('#9: a non-bare anchor repo (absolute or traversal) is repo_unavailable / anchor_unchecked, never a hash oracle', async () => {
  const { checkAnchors } = await import('../src/lib/anchors.js');
  const { computeDrift } = await import('../src/lib/drift.js');
  const { createHash } = await import('node:crypto');
  const project = await makeTempProject();
  await runCli(['init', '--cwd', project]);

  const passwd = await readFile('/etc/passwd');
  const sha = createHash('sha1').update(`blob ${passwd.length}\0`).update(passwd).digest('hex');

  // (An empty `repo` is falsy and takes the repo-less path — contained to the
  // project root, so it reads `missing`, which is also no oracle.)
  for (const repo of ['/etc', '../../../../../../../etc', '.', '..', 'a/b', 'a\\b']) {
    const statuses = checkAnchors(project, [{ file: 'passwd', sha, repo }]);
    assert.equal(statuses[0].status, 'repo_unavailable', `repo=${JSON.stringify(repo)} via checkAnchors`);
    assert.equal(statuses[0].currentSha, null);
    const drift = computeDrift(project, [{ file: 'passwd', sha, repo }]);
    assert.deepEqual(drift, { drifted: false, anchor_unchecked: true, drift: [{ file: 'passwd', status: 'repo_unavailable' }] }, `repo=${JSON.stringify(repo)} via computeDrift`);
  }

  // The same record through the CLI reads as unchecked, and verify needs review.
  const id = 'ms_01J0000000000000000000000A';
  await writeFile(join(project, '.memspec', 'memory', 'facts', `${id}.md`), [
    '---', `id: ${id}`, 'kind: claim', 'type: fact', 'state: active', 'created: 2026-01-01T00:00:00.000Z',
    'source: planted', 'tags: []', 'check_by: never', 'verified_with: anchor',
    'anchors:', '  - file: passwd', `    sha: ${sha}`, '    repo: /etc', '---', '# Passwd oracle', '',
  ].join('\n'));
  const row = JSON.parse((await runCli(['search', 'passwd oracle', '--cwd', project, '--json'])).stdout).results
    .find((r: { id: string }) => r.id === id);
  assert.equal(row.drifted, false);
  assert.equal(row.anchor_unchecked, true);
  // needs_review exits 1 on the CLI, so the call rejects; the report is on stdout.
  await assert.rejects(
    () => runCli(['verify', id, '--cwd', project]),
    (err: Error & { stdout?: string; stderr?: string }) => {
      assert.match(err.stdout ?? '', /NEEDS REVIEW/);
      assert.match(err.stderr ?? '', /is not a bare repository name/);
      return true;
    },
  );
});
