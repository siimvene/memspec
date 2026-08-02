import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { makeTempProject, runCli } from './helpers.js';
import { searchPayload } from '../src/commands/search.js';
import { runRemember } from '../src/commands/remember.js';
import { MemspecStore } from '../src/lib/store.js';

/**
 * Record scoping — the read-side anti-pollination layer.
 *
 * One store accumulating records from a dozen unrelated projects makes every
 * query a lottery: searching while working on project A surfaces the noise of
 * B, C and D. `scopes:` partitions the store by working directory, and each
 * record carries an optional `scope` naming the partition it belongs to.
 *
 * Three record states, all deliberate:
 *   absent      → visible everywhere (every pre-scoping record is here)
 *   universal   → explicitly visible everywhere
 *   <name>      → visible only while <name> is the active scope
 */

/**
 * A store whose config declares `scopes:`. Patterns are absolute so they
 * behave identically regardless of where the test process was launched.
 */
async function makeScopedProject(scopes: Record<string, string[]>): Promise<string> {
  const project = await makeTempProject();
  await runCli(['init', '--cwd', project, '--no-interactive', '--no-install-hooks']);
  await appendConfig(project, renderScopes(scopes));
  return project;
}

function renderScopes(scopes: Record<string, string[]>): string {
  const lines = ['scopes:'];
  for (const [name, patterns] of Object.entries(scopes)) {
    lines.push(`  ${name}: [${patterns.map((p) => `'${p}'`).join(', ')}]`);
  }
  return lines.join('\n') + '\n';
}

async function appendConfig(project: string, block: string): Promise<void> {
  const path = join(project, '.memspec', 'config.yaml');
  const existing = await readFile(path, 'utf8');
  await writeFile(path, `${existing}\n${block}`, 'utf8');
}

/**
 * Write a record straight through the store, bypassing `remember`'s neighbour
 * walk. Bulk seeding is the point: 60 records through `remember` means 60 FTS
 * rebuilds, and the duplicate inference would fight the fixture.
 */
function seed(project: string, title: string, body: string, scope?: string): string {
  const store = new MemspecStore(project);
  const id = `ms_${ulid()}`;
  store.writeItem({
    id,
    kind: 'claim',
    type: 'fact',
    state: 'active',
    created: new Date().toISOString(),
    source: 'test',
    tags: [],
    check_by: 'never',
    ...(scope ? { scope } : {}),
    title,
    body,
  });
  return id;
}

// --- backward compatibility --------------------------------------------------

test('no scopes: config means no filtering at all', async () => {
  const project = await makeTempProject();
  await runCli(['init', '--cwd', project, '--no-interactive', '--no-install-hooks']);

  seed(project, 'Unscoped ledger fact', 'The ledger reconciles nightly.');
  seed(project, 'Scoped ledger fact', 'The ledger reconciles nightly.', 'plg');
  seed(project, 'Universal ledger fact', 'The ledger reconciles nightly.', 'universal');

  const payload = searchPayload('ledger', { cwd: project });
  assert.equal(payload.count, 3, 'a store without scopes: must behave exactly as it did before scoping');
});

test('a record with no scope field is visible from every active scope', async () => {
  const project = await makeScopedProject({ kleidia: ['/nowhere/kleidia'], plg: ['/nowhere/plg'] });
  seed(project, 'Legacy unscoped fact', 'Written before scoping existed.');

  for (const scope of ['kleidia', 'plg']) {
    const payload = searchPayload('unscoped', { cwd: project, scope });
    assert.equal(payload.count, 1, `unscoped record must survive active scope ${scope}`);
  }
});

test('a record scoped universal is visible from every active scope', async () => {
  const project = await makeScopedProject({ kleidia: ['/nowhere/kleidia'], plg: ['/nowhere/plg'] });
  seed(project, 'Universal tooling fact', 'Applies to every project.', 'universal');

  for (const scope of ['kleidia', 'plg']) {
    const payload = searchPayload('tooling', { cwd: project, scope });
    assert.equal(payload.count, 1, `universal record must survive active scope ${scope}`);
    assert.equal(payload.results[0]?.title, 'Universal tooling fact');
  }
});

// --- the actual partition ----------------------------------------------------

test('a record scoped plg is not returned when the active scope is kleidia', async () => {
  const project = await makeScopedProject({ kleidia: ['/nowhere/kleidia'], plg: ['/nowhere/plg'] });
  seed(project, 'Ticketing checkout flow', 'Checkout is a three-step flow.', 'plg');

  const own = searchPayload('checkout', { cwd: project, scope: 'plg' });
  assert.equal(own.count, 1, 'its own scope must still see it');

  const other = searchPayload('checkout', { cwd: project, scope: 'kleidia' });
  assert.equal(other.count, 0, 'a foreign scope must not see it');
});

// --- candidate-set filtering (the starvation case) ---------------------------

/**
 * The requirement this test exists for: the scope predicate has to constrain
 * the candidate set inside the FTS query, not trim an already-fetched page.
 *
 * `MemspecStore.search` asks FTS for `limit * 2` rows. Here 60 out-of-scope
 * records outrank the 2 in-scope ones on every BM25 signal (query term in
 * title + tags, weighted 10 and 5, versus body-only at weight 1), so a
 * post-filter over that page would see nothing but `plg` records and return
 * zero results. Verified by removing the SQL predicate and re-running: this
 * test fails with `0 !== 2`, and it is the only one in the file that does.
 */
test('a small scope is not starved out of the candidate page by a large one', async () => {
  const project = await makeScopedProject({ kleidia: ['/nowhere/kleidia'], plg: ['/nowhere/plg'] });

  for (let i = 0; i < 60; i++) {
    seed(
      project,
      `Widget pipeline note ${i}`,
      '# heading\n\nwidget widget widget pipeline widget notes.',
      'plg',
    );
  }
  seed(project, 'Rendering surface A', 'The widget lives behind an adapter.', 'kleidia');
  seed(project, 'Rendering surface B', 'A second widget detail worth keeping.', 'kleidia');

  const payload = searchPayload('widget', { cwd: project, scope: 'kleidia', limit: '5' });
  assert.equal(payload.count, 2, 'both in-scope records must survive a page dominated by out-of-scope matches');
  assert.deepEqual(
    payload.results.map((r) => r.title).sort(),
    ['Rendering surface A', 'Rendering surface B'],
  );
});

// --- write path --------------------------------------------------------------

test('remember stamps the scope derived from a matching cwd', async () => {
  const project = await makeTempProject();
  await runCli(['init', '--cwd', project, '--no-interactive', '--no-install-hooks']);
  await appendConfig(project, renderScopes({ kleidia: [project], plg: ['/nowhere/plg'] }));

  const result = runRemember('fact', 'Session cache lives in Redis', {
    cwd: project,
    body: 'Derived from the working directory.',
    source: 'test',
  });

  assert.equal(result.scope, 'kleidia');
  const written = await readFile(result.filePath, 'utf8');
  assert.match(written, /^scope: kleidia$/m);
});

test('remember writes no scope field when the cwd matches nothing', async () => {
  const project = await makeTempProject();
  await runCli(['init', '--cwd', project, '--no-interactive', '--no-install-hooks']);
  await appendConfig(project, renderScopes({ kleidia: ['/nowhere/kleidia'] }));

  const result = runRemember('fact', 'Session cache lives in Redis', {
    cwd: project,
    body: 'No scope claims this directory.',
    source: 'test',
  });

  assert.equal(result.scope, undefined);
  const written = await readFile(result.filePath, 'utf8');
  assert.doesNotMatch(written, /^scope:/m, 'absent and universal are different states — absent must stay absent');
});

test('an explicit scope argument overrides cwd derivation', async () => {
  const project = await makeTempProject();
  await runCli(['init', '--cwd', project, '--no-interactive', '--no-install-hooks']);
  await appendConfig(project, renderScopes({ kleidia: [project], plg: ['/nowhere/plg'] }));

  const explicit = runRemember('fact', 'Refunds run through the ledger', {
    cwd: project,
    body: 'The cwd says kleidia; the caller knows better.',
    source: 'test',
    scope: 'plg',
  });
  assert.equal(explicit.scope, 'plg');

  const universal = runRemember('fact', 'Every project uses UTC internally', {
    cwd: project,
    body: 'Explicitly classified as global.',
    source: 'test',
    scope: 'universal',
  });
  assert.equal(universal.scope, 'universal');

  // And the same override on the read side.
  const asPlg = searchPayload('refunds', { cwd: project, scope: 'plg' });
  assert.equal(asPlg.count, 1);
  const asKleidia = searchPayload('refunds', { cwd: project, scope: 'kleidia' });
  assert.equal(asKleidia.count, 0);
});

test('search derives the active scope from cwd when none is passed', async () => {
  const project = await makeTempProject();
  await runCli(['init', '--cwd', project, '--no-interactive', '--no-install-hooks']);
  await appendConfig(project, renderScopes({ kleidia: [project], plg: ['/nowhere/plg'] }));

  seed(project, 'Foreign deployment note', 'Deployment happens on Thursdays.', 'plg');
  seed(project, 'Local deployment note', 'Deployment happens on Fridays.', 'kleidia');

  const payload = searchPayload('deployment', { cwd: project });
  assert.equal(payload.count, 1, 'cwd resolves to kleidia, so the plg record stays hidden');
  assert.equal(payload.results[0]?.title, 'Local deployment note');
});

// --- malformed configuration -------------------------------------------------

const MALFORMED_CASES: Array<{ name: string; yaml: string; expect: RegExp }> = [
  {
    name: 'scopes declared as a list instead of a mapping',
    yaml: 'scopes:\n  - kleidia\n  - plg\n',
    expect: /mapping of scope name to path patterns/,
  },
  {
    name: 'a scope whose patterns are a bare string',
    yaml: 'scopes:\n  kleidia: /git/kleidia\n',
    expect: /scopes\.kleidia must be a non-empty list/,
  },
  {
    name: 'a relative pattern that would resolve against the process cwd',
    yaml: "scopes:\n  kleidia: ['git/kleidia']\n",
    expect: /must be absolute or start with "~"/,
  },
  {
    name: 'a scope named universal, colliding with the reserved value',
    yaml: "scopes:\n  universal: ['/git/anything']\n",
    expect: /reserved scope name/,
  },
  {
    name: 'a claims list with a relative pattern',
    yaml: "claims: ['git/kleidia']\n",
    expect: /claims pattern "git\/kleidia" must be absolute/,
  },
];

for (const testCase of MALFORMED_CASES) {
  test(`malformed config surfaces an error: ${testCase.name}`, async () => {
    const project = await makeTempProject();
    await runCli(['init', '--cwd', project, '--no-interactive', '--no-install-hooks']);
    await appendConfig(project, testCase.yaml);

    assert.throws(
      () => searchPayload('anything', { cwd: project }),
      testCase.expect,
      'a typo must fail loudly, not silently match nothing',
    );
  });
}

test('an unknown explicit scope is rejected rather than silently hiding the record', async () => {
  const project = await makeScopedProject({ kleidia: ['/nowhere/kleidia'], plg: ['/nowhere/plg'] });

  assert.throws(
    () => runRemember('fact', 'Typo scope target', { cwd: project, source: 'test', scope: 'kliedia' }),
    /unknown scope "kliedia"/,
  );
  assert.throws(
    () => searchPayload('anything', { cwd: project, scope: 'kliedia' }),
    /unknown scope "kliedia"/,
  );
});

// --- CLI surface -------------------------------------------------------------

test('CLI --scope threads through remember and search', async () => {
  const project = await makeScopedProject({ kleidia: ['/nowhere/kleidia'], plg: ['/nowhere/plg'] });

  await runCli([
    'remember', 'fact', 'Invoices are generated nightly',
    '--cwd', project, '--source', 'test', '--scope', 'plg',
    '--body', 'Billing runs at 02:00.',
  ]);

  const hit = await runCli(['search', 'invoices', '--cwd', project, '--scope', 'plg', '--json']);
  assert.equal(JSON.parse(hit.stdout).length, 1);

  const miss = await runCli(['search', 'invoices', '--cwd', project, '--scope', 'kleidia', '--json']);
  assert.equal(miss.stdout.trim(), '[]');
});

// --- stale on-disk index -----------------------------------------------------

test('an FTS cache written before the scope column is rebuilt, not trusted', async () => {
  const project = await makeScopedProject({ kleidia: ['/nowhere/kleidia'], plg: ['/nowhere/plg'] });
  seed(project, 'Cache invalidation note', 'The index is disposable.', 'kleidia');

  // Warm the cache, then replace it with a pre-scoping schema whose mtime is
  // newer than every source file — the freshness check alone would trust it.
  searchPayload('invalidation', { cwd: project, scope: 'kleidia' });

  const { default: Database } = await import('better-sqlite3');
  const cachePath = join(project, '.memspec', '.fts.db');
  const db = new Database(cachePath);
  db.exec('DROP TABLE IF EXISTS items_fts; DROP TABLE IF EXISTS items;');
  db.exec('CREATE TABLE items (id TEXT PRIMARY KEY, type TEXT NOT NULL, created TEXT NOT NULL);');
  db.exec("CREATE VIRTUAL TABLE items_fts USING fts5(id UNINDEXED, title, tags, body, tokenize = 'porter unicode61');");
  db.close();

  const payload = searchPayload('invalidation', { cwd: project, scope: 'kleidia' });
  assert.equal(payload.count, 1, 'an old-schema cache must be dropped and repopulated');
});
