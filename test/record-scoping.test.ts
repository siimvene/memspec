import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { makeTempProject, runCli } from './helpers.js';
import { runContext } from '../src/commands/context.js';
import { searchPayload } from '../src/commands/search.js';
import { runObserve } from '../src/commands/observe.js';
import { runRemember } from '../src/commands/remember.js';
import { runSupersede } from '../src/commands/supersede.js';
import { parseScopesConfig } from '../src/lib/config.js';
import { resolveScopeForCwd } from '../src/lib/scope.js';
import { MemspecStore } from '../src/lib/store.js';
import type { MemoryFrontmatter } from '../src/lib/types.js';

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
function seed(
  project: string,
  title: string,
  body: string,
  scope?: string,
  extra: Partial<MemoryFrontmatter> = {},
): string {
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
    ...extra,
    title,
    body,
  });
  return id;
}

/** Move a seeded record into `archive/` as superseded, so it survives only there. */
function archiveAsSuperseded(project: string, id: string): void {
  const store = new MemspecStore(project);
  const item = store.findById(id);
  assert.ok(item, `seeded record ${id} must be loadable before it can be archived`);
  store.moveToArchive(item, 'superseded');
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

// --- graph expansion ---------------------------------------------------------

/**
 * The seed pass is filtered inside SQL, the expansion pass reads its own pool.
 * Fixing one and not the other means the partition holds until someone passes
 * expand_edges — at which point a single typed edge walks straight through it.
 */
test('graph expansion does not surface a record from another scope', async () => {
  const project = await makeScopedProject({ alpha: ['/nowhere/alpha'], beta: ['/nowhere/beta'] });
  const betaId = seed(project, 'Beta payment reconciliation', 'Beta reconciles payments hourly.', 'beta');
  seed(project, 'Alpha gateway routing', 'The alpha gateway routes by tenant.', 'alpha', { refines: [betaId] });

  const payload = searchPayload('gateway', {
    cwd: project,
    scope: 'alpha',
    expandEdges: true,
  });

  assert.equal(payload.count, 1, 'only the in-scope seed may be returned');
  assert.ok(
    !payload.results.some((r) => r.id === betaId),
    'a refines edge must not carry a beta record into an alpha result set',
  );
});

/**
 * The traversal semantics this codebase chose: an out-of-scope record is a
 * wall, not a stepping stone. Letting the walk pass through it would leak the
 * shape of the foreign graph — the neighbours of a record you may not see
 * would still arrive.
 */
test('an out-of-scope record blocks the path rather than acting as an invisible hop', async () => {
  const project = await makeScopedProject({ alpha: ['/nowhere/alpha'], beta: ['/nowhere/beta'] });
  const farId = seed(project, 'Alpha settlement ledger', 'Settlement runs after cutoff.', 'alpha');
  const betaId = seed(project, 'Beta payment reconciliation', 'Beta reconciles payments hourly.', 'beta', {
    refines: [farId],
  });
  seed(project, 'Alpha gateway routing', 'The alpha gateway routes by tenant.', 'alpha', { refines: [betaId] });

  const payload = searchPayload('gateway', {
    cwd: project,
    scope: 'alpha',
    expandEdges: true,
    expandDepth: 2,
  });

  assert.deepEqual(
    payload.results.map((r) => r.title),
    ['Alpha gateway routing'],
    'neither the beta record nor anything reachable only through it may surface',
  );
  assert.ok(!payload.results.some((r) => r.id === farId));
});

test('expansion still crosses edges inside the active scope', async () => {
  const project = await makeScopedProject({ alpha: ['/nowhere/alpha'], beta: ['/nowhere/beta'] });
  const siblingId = seed(project, 'Alpha settlement ledger', 'Settlement runs after cutoff.', 'alpha');
  seed(project, 'Alpha gateway routing', 'The alpha gateway routes by tenant.', 'alpha', { refines: [siblingId] });

  const payload = searchPayload('gateway', { cwd: project, scope: 'alpha', expandEdges: true });

  assert.equal(payload.count, 2, 'the scope filter must not disconnect an in-scope subgraph');
  const expanded = payload.results.find((r) => r.id === siblingId);
  assert.equal(expanded?.expanded_via?.edge_type, 'refines');
});

test('expansion surfaces unscoped and universal neighbours from any scope', async () => {
  const project = await makeScopedProject({ alpha: ['/nowhere/alpha'], beta: ['/nowhere/beta'] });
  const legacyId = seed(project, 'Legacy settlement ledger', 'Written before scoping existed.');
  const universalId = seed(project, 'Universal clock policy', 'Everything is UTC internally.', 'universal');
  seed(project, 'Alpha gateway routing', 'The alpha gateway routes by tenant.', 'alpha', {
    refines: [legacyId],
    depends_on: [universalId],
  });

  const payload = searchPayload('gateway', { cwd: project, scope: 'alpha', expandEdges: true });
  const ids = payload.results.map((r) => r.id);
  assert.ok(ids.includes(legacyId), 'an unscoped record is visible from every scope, including via expansion');
  assert.ok(ids.includes(universalId), 'a universal record is visible from every scope, including via expansion');
});

// --- supersede: the correction path ------------------------------------------

/**
 * Supersede is the documented way to correct stale knowledge, so a replacement
 * that drops the scope demotes a scoped record back to "visible from every
 * project" on every single correction — silently reintroducing the pollution
 * scoping exists to prevent.
 */
function scopeOf(project: string, id: string): string | undefined {
  const item = new MemspecStore(project).findById(id);
  assert.ok(item, `record ${id} must be loadable`);
  return item.scope;
}

test('a replacement inherits the scope of the record it supersedes', async () => {
  const project = await makeScopedProject({ alpha: ['/nowhere/alpha'], beta: ['/nowhere/beta'] });
  const targetId = seed(project, 'Alpha gateway routing', 'The alpha gateway routes by tenant.', 'alpha');

  const result = runSupersede(targetId, {
    cwd: project,
    reason: 'routing changed',
    body: 'The alpha gateway now routes by region.',
    source: 'test',
  });

  assert.equal(scopeOf(project, result.survivor_id), 'alpha', 'a correction to an alpha claim is still alpha knowledge');
  assert.equal(scopeOf(project, targetId), 'alpha', 'the archived original keeps its own stamp');

  const asBeta = searchPayload('gateway', { cwd: project, scope: 'beta' });
  assert.equal(asBeta.count, 0, 'the replacement must not leak into another scope');
});

test('superseding an unscoped record leaves the replacement unscoped', async () => {
  const project = await makeTempProject();
  await runCli(['init', '--cwd', project, '--no-interactive', '--no-install-hooks']);
  // cwd resolves to alpha, so a replacement that derived its scope instead of
  // inheriting it would arrive stamped — absent must survive the round trip.
  await appendConfig(project, renderScopes({ alpha: [project], beta: ['/nowhere/beta'] }));
  const targetId = seed(project, 'Legacy ledger fact', 'Written before scoping existed.');

  const result = runSupersede(targetId, {
    cwd: project,
    reason: 'reconciliation moved to hourly',
    body: 'The ledger reconciles hourly.',
    source: 'test',
  });

  assert.equal(scopeOf(project, result.survivor_id), undefined);
  const written = await readFile(new MemspecStore(project).findById(result.survivor_id)!.filePath, 'utf8');
  assert.doesNotMatch(written, /^scope:/m, 'absent and universal are different states — absent must stay absent');
});

test('an explicit scope on supersede overrides inheritance', async () => {
  const project = await makeScopedProject({ alpha: ['/nowhere/alpha'], beta: ['/nowhere/beta'] });
  const targetId = seed(project, 'Alpha gateway routing', 'The alpha gateway routes by tenant.', 'alpha');

  const result = runSupersede(targetId, {
    cwd: project,
    reason: 'this was beta knowledge all along',
    body: 'The beta gateway routes by tenant.',
    source: 'test',
    scope: 'beta',
  });

  assert.equal(scopeOf(project, result.survivor_id), 'beta');

  assert.throws(
    () => runSupersede(seed(project, 'Another alpha note', 'Alpha detail.', 'alpha'), {
      cwd: project,
      reason: 'typo scope',
      body: 'Replacement.',
      source: 'test',
      scope: 'btea',
    }),
    /unknown scope "btea"/,
    'a typo must fail loudly rather than hide the survivor from every scope',
  );
});

/**
 * The merge rule is unanimity or refusal. Every silent tie-break loses
 * something, and the two losses point opposite ways: collapsing alpha + beta to
 * absent republishes the content to every unrelated scope, while collapsing
 * absent + alpha to alpha hides content that used to be readable everywhere.
 * The tests below pin both refusals, and the frictionless unanimous paths that
 * make the refusal affordable.
 */
test('a merge whose contributors all carry the same scope keeps it', async () => {
  const project = await makeScopedProject({ alpha: ['/nowhere/alpha'], beta: ['/nowhere/beta'] });
  const targetId = seed(project, 'Alpha gateway routing', 'The alpha gateway routes by tenant.', 'alpha');
  const agreeing = seed(project, 'Alpha routing detail', 'Tenant routing lives in the gateway.', 'alpha');
  const alsoAgreeing = seed(project, 'Alpha routing aside', 'Routing is table-driven.', 'alpha');

  const result = runSupersede(targetId, {
    cwd: project,
    reason: 'three notes describing one thing',
    body: 'Consolidated alpha routing.',
    source: 'test',
    mergeFrom: [agreeing, alsoAgreeing],
  });

  assert.equal(scopeOf(project, result.survivor_id), 'alpha');
  assert.equal(result.superseded_ids.length, 3);
});

test('a merge whose contributors are all unscoped leaves the survivor unscoped', async () => {
  const project = await makeTempProject();
  await runCli(['init', '--cwd', project, '--no-interactive', '--no-install-hooks']);
  // cwd resolves to alpha, so a survivor that derived rather than inherited
  // would arrive stamped — unanimous absence must survive the merge.
  await appendConfig(project, renderScopes({ alpha: [project], beta: ['/nowhere/beta'] }));
  const targetId = seed(project, 'Legacy ledger fact', 'Written before scoping existed.');

  const result = runSupersede(targetId, {
    cwd: project,
    reason: 'two legacy notes describing one thing',
    body: 'Consolidated legacy ledger.',
    source: 'test',
    mergeFrom: [seed(project, 'Legacy ledger aside', 'Also written before scoping existed.')],
  });

  assert.equal(scopeOf(project, result.survivor_id), undefined);
  const written = await readFile(new MemspecStore(project).findById(result.survivor_id)!.filePath, 'utf8');
  assert.doesNotMatch(written, /^scope:/m, 'absent and universal are different states — absent must stay absent');
});

test('a merge whose scoped contributors disagree is refused', async () => {
  const project = await makeScopedProject({ alpha: ['/nowhere/alpha'], beta: ['/nowhere/beta'] });
  const targetId = seed(project, 'Alpha gateway routing', 'The alpha gateway routes by tenant.', 'alpha');
  const foreign = seed(project, 'Beta gateway routing', 'The beta gateway routes by tenant.', 'beta');

  assert.throws(
    () => runSupersede(targetId, {
      cwd: project,
      reason: 'same claim, two projects',
      body: 'Both gateways route by tenant.',
      source: 'test',
      mergeFrom: [foreign],
    }),
    (error: Error) => {
      assert.match(error.message, /alpha/, 'the caller has to be told which scopes collided');
      assert.match(error.message, /beta/);
      assert.match(error.message, /universal/, 'universal is the answer when the merged claim really is global');
      return true;
    },
  );

  // Refused before anything moved: both records are still active and readable
  // from their own scopes.
  assert.equal(scopeOf(project, targetId), 'alpha');
  assert.equal(scopeOf(project, foreign), 'beta');
});

test('a merge of an unscoped record with a scoped one is refused', async () => {
  const project = await makeScopedProject({ alpha: ['/nowhere/alpha'], beta: ['/nowhere/beta'] });
  const targetId = seed(project, 'Alpha gateway routing', 'The alpha gateway routes by tenant.', 'alpha');
  // Inheriting alpha here would hide a record beta could previously read, which
  // is a loss in the opposite direction to the alpha+beta case above.
  const unscoped = seed(project, 'Routing note', 'Written before scoping existed.');

  assert.throws(
    () => runSupersede(targetId, {
      cwd: project,
      reason: 'a legacy note describing the same routing',
      body: 'Consolidated routing.',
      source: 'test',
      mergeFrom: [unscoped],
    }),
    /\(none\)/,
    'the absent contributor must read as a value, not as "undefined"',
  );
});

test('an explicit scope settles a merge the inference refuses', async () => {
  const project = await makeScopedProject({ alpha: ['/nowhere/alpha'], beta: ['/nowhere/beta'] });
  const targetId = seed(project, 'Alpha gateway routing', 'The alpha gateway routes by tenant.', 'alpha');
  const foreign = seed(project, 'Beta gateway routing', 'The beta gateway routes by tenant.', 'beta');

  const result = runSupersede(targetId, {
    cwd: project,
    reason: 'both gateways behave the same way',
    body: 'Every gateway routes by tenant.',
    source: 'test',
    mergeFrom: [foreign],
    scope: 'universal',
  });

  assert.equal(scopeOf(project, result.survivor_id), 'universal');
  for (const scope of ['alpha', 'beta']) {
    assert.equal(searchPayload('gateway', { cwd: project, scope }).count, 1, `${scope} must reach the survivor`);
  }
});

test('a merge with no replacement body enforces the same rule on the surviving record', async () => {
  const project = await makeScopedProject({ alpha: ['/nowhere/alpha'], beta: ['/nowhere/beta'] });

  const agreeingSurvivor = seed(project, 'Alpha gateway routing', 'The alpha gateway routes by tenant.', 'alpha');
  runSupersede(agreeingSurvivor, {
    cwd: project,
    reason: 'duplicate alpha note',
    source: 'test',
    mergeFrom: [seed(project, 'Alpha routing detail', 'Tenant routing lives in the gateway.', 'alpha')],
  });
  assert.equal(scopeOf(project, agreeingSurvivor), 'alpha', 'agreement leaves the survivor stamp untouched');

  const conflictedSurvivor = seed(project, 'Alpha settlement ledger', 'Settlement runs after cutoff.', 'alpha');
  const foreign = seed(project, 'Beta settlement ledger', 'Settlement runs after cutoff.', 'beta');
  assert.throws(
    () => runSupersede(conflictedSurvivor, {
      cwd: project,
      reason: 'the same ledger claim arrived from beta',
      source: 'test',
      mergeFrom: [foreign],
    }),
    /alpha, beta/,
  );
  assert.equal(scopeOf(project, conflictedSurvivor), 'alpha', 'a refused merge leaves the survivor untouched');
  assert.equal(scopeOf(project, foreign), 'beta', 'and does not archive the contributor');

  // Naming the scope resolves it, on the branch where the target itself survives.
  runSupersede(conflictedSurvivor, {
    cwd: project,
    reason: 'the same ledger claim arrived from beta',
    source: 'test',
    mergeFrom: [foreign],
    scope: 'universal',
  });
  assert.equal(scopeOf(project, conflictedSurvivor), 'universal');
});

test('retracting a record leaves its scope on the archived copy', async () => {
  const project = await makeScopedProject({ alpha: ['/nowhere/alpha'], beta: ['/nowhere/beta'] });
  const targetId = seed(project, 'Alpha gateway routing', 'The alpha gateway routes by tenant.', 'alpha');

  runSupersede(targetId, { cwd: project, reason: 'no longer true', source: 'test' });

  assert.equal(scopeOf(project, targetId), 'alpha');
});

// --- observe -----------------------------------------------------------------

test('observe stamps the scope derived from a matching cwd', async () => {
  const project = await makeTempProject();
  await runCli(['init', '--cwd', project, '--no-interactive', '--no-install-hooks']);
  await appendConfig(project, renderScopes({ alpha: [project], beta: ['/nowhere/beta'] }));

  const derived = runObserve({ cwd: project, text: 'The deploy script printed a checksum mismatch.' });
  assert.equal(derived.scope, 'alpha');
  assert.match(await readFile(derived.filePath, 'utf8'), /^scope: alpha$/m);

  const explicit = runObserve({ cwd: project, text: 'The beta dashboard was empty.', scope: 'beta' });
  assert.equal(explicit.scope, 'beta', 'an explicit scope overrides cwd derivation');
});

test('observe writes no scope field when the cwd matches nothing', async () => {
  const project = await makeTempProject();
  await runCli(['init', '--cwd', project, '--no-interactive', '--no-install-hooks']);
  await appendConfig(project, renderScopes({ alpha: ['/nowhere/alpha'] }));

  const result = runObserve({ cwd: project, text: 'No scope claims this directory.' });

  assert.equal(result.scope, undefined);
  assert.doesNotMatch(await readFile(result.filePath, 'utf8'), /^scope:/m);
});

// --- store selection vs. working directory -----------------------------------

test('writing to a store outside the project still derives the scope from cwd', async () => {
  const globalStore = await makeTempProject();
  const project = await makeTempProject();
  await runCli(['init', '--cwd', globalStore, '--no-interactive', '--no-install-hooks']);
  await appendConfig(globalStore, renderScopes({ kleidia: [project], plg: ['/nowhere/plg'] }));

  const result = runRemember('fact', 'Refunds settle on the ledger', {
    cwd: project,
    storeRoot: globalStore,
    body: 'Written to the global store while working on kleidia.',
    source: 'test',
  });

  assert.equal(result.scope, 'kleidia', 'the store moved, the project did not');
  assert.ok(result.filePath.startsWith(join(globalStore, '.memspec')), 'the record still belongs in the named store');
  const written = await readFile(result.filePath, 'utf8');
  assert.match(written, /^scope: kleidia$/m);
});

test('CLI --store global keeps the scope derived from the project cwd', async () => {
  // HOME is redirected so `--store global` resolves to a throwaway store; the
  // operator's real ~/.memspec is never touched.
  const fakeHome = await makeTempProject();
  const project = await makeTempProject();
  await runCli(['init', '--cwd', fakeHome, '--no-interactive', '--no-install-hooks']);
  await appendConfig(fakeHome, renderScopes({ kleidia: [project], plg: ['/nowhere/plg'] }));

  const { stdout } = await runCli(
    [
      'remember', 'fact', 'Chief architect owns the rollout',
      '--cwd', project, '--source', 'test', '--store', 'global',
      '--body', 'Cross-project knowledge, still a kleidia claim.',
    ],
    undefined,
    { HOME: fakeHome },
  );

  assert.match(stdout, /Scope: kleidia/, '--store global must not erase the scope stamp');
  const filePath = /at (\S+\.md)/.exec(stdout)?.[1];
  assert.ok(filePath?.startsWith(join(fakeHome, '.memspec')), `expected a write into the global store, got ${filePath}`);
  const written = await readFile(filePath!, 'utf8');
  assert.match(written, /^scope: kleidia$/m);
});

// --- unknown scope names -----------------------------------------------------

/**
 * The sequencing that makes this subtle: records are stamped with a scope
 * before the `scopes:` block is written, so "not in config" cannot mean
 * "unknown". Validating against the scopes actually present in the store is
 * what turns a typo from quiet under-retrieval into an error.
 */
test('a typo is rejected against the scopes present in a store with no scopes: block', async () => {
  const project = await makeTempProject();
  await runCli(['init', '--cwd', project, '--no-interactive', '--no-install-hooks']);
  seed(project, 'Kleidia ledger note', 'The ledger reconciles nightly.', 'kleidia');
  seed(project, 'Shared tooling note', 'The ledger is inspected with the same CLI.', 'universal');

  const correct = searchPayload('ledger', { cwd: project, scope: 'kleidia' });
  assert.equal(correct.count, 2, 'the real scope name still answers');

  assert.throws(
    () => searchPayload('ledger', { cwd: project, scope: 'kleida' }),
    /unknown scope "kleida"/,
    'a typo must not silently degrade to "unscoped and universal records only"',
  );
});

/**
 * The inventory has to cover every record state, not just the active ones.
 * A scope whose last record was superseded is still a real name, and
 * `--include-superseded` exists precisely to reach into that archive — being
 * refused at the scope check is the one thing that makes the flag unusable.
 */
test('a scope surviving only on a superseded record is still a known scope name', async () => {
  const project = await makeTempProject();
  await runCli(['init', '--cwd', project, '--no-interactive', '--no-install-hooks']);
  seed(project, 'Alpha widget record', 'Alpha scope widget configuration.', 'alpha');
  archiveAsSuperseded(project, seed(project, 'Beta secret record', 'Confidential beta-only content.', 'beta'));

  assert.deepEqual(
    new MemspecStore(project).scopesInUse().sort(),
    ['alpha', 'beta'],
    'the inventory is every scope stamped in the store, not every scope stamped on an active record',
  );
  assert.doesNotThrow(
    () => searchPayload('secret', { cwd: project, scope: 'beta', includeSuperseded: true }),
    'the archive is the only place beta lives, and it was explicitly asked for',
  );
});

test('a scope matching neither config nor any archived record is still rejected', async () => {
  const project = await makeTempProject();
  await runCli(['init', '--cwd', project, '--no-interactive', '--no-install-hooks']);
  archiveAsSuperseded(project, seed(project, 'Beta secret record', 'Confidential beta-only content.', 'beta'));

  assert.throws(
    () => searchPayload('secret', { cwd: project, scope: 'btea', includeSuperseded: true }),
    /unknown scope "btea"/,
    'widening the inventory to archived records must not widen it to everything',
  );
});

test('any scope name is accepted while no scope exists anywhere yet', async () => {
  const project = await makeTempProject();
  await runCli(['init', '--cwd', project, '--no-interactive', '--no-install-hooks']);
  seed(project, 'Unscoped ledger note', 'The ledger reconciles nightly.');

  // Nothing to validate against — no config, no stamped record. Rejecting here
  // would make a fresh store unusable before its first scoped write.
  const payload = searchPayload('ledger', { cwd: project, scope: 'kleidia' });
  assert.equal(payload.count, 1);
});

// --- context (session priming) -----------------------------------------------

test('context boot list is filtered to the active scope', async () => {
  const project = await makeScopedProject({ kleidia: ['/nowhere/kleidia'], plg: ['/nowhere/plg'] });
  seed(project, 'Ticketing checkout flow', 'Checkout is a three-step flow.', 'plg');
  seed(project, 'Rendering surface adapter', 'The widget lives behind an adapter.', 'kleidia');
  seed(project, 'Legacy unscoped note', 'Written before scoping existed.');

  const output = runContext({ cwd: project, scope: 'kleidia' });
  assert.match(output, /Rendering surface adapter/);
  assert.match(output, /Legacy unscoped note/, 'unscoped records stay visible from every scope');
  assert.doesNotMatch(output, /Ticketing checkout flow/, 'boot must not prime the session with another project');
});

test('context query path is filtered to the active scope', async () => {
  const project = await makeScopedProject({ kleidia: ['/nowhere/kleidia'], plg: ['/nowhere/plg'] });
  seed(project, 'Foreign deployment note', 'Deployment happens on Thursdays.', 'plg');
  seed(project, 'Local deployment note', 'Deployment happens on Fridays.', 'kleidia');

  const output = runContext({ cwd: project, scope: 'kleidia', query: 'deployment' });
  assert.match(output, /Local deployment note/);
  assert.doesNotMatch(output, /Foreign deployment note/);
});

test('context derives the active scope from cwd when none is passed', async () => {
  const project = await makeTempProject();
  await runCli(['init', '--cwd', project, '--no-interactive', '--no-install-hooks']);
  await appendConfig(project, renderScopes({ kleidia: [project], plg: ['/nowhere/plg'] }));

  seed(project, 'Foreign deployment note', 'Deployment happens on Thursdays.', 'plg');
  seed(project, 'Local deployment note', 'Deployment happens on Fridays.', 'kleidia');

  const output = runContext({ cwd: project });
  assert.match(output, /Local deployment note/);
  assert.doesNotMatch(output, /Foreign deployment note/);
});

// --- prototype-polluting scope names -----------------------------------------

/**
 * `scopes['__proto__'] = [...]` on an object literal writes the prototype
 * instead of creating an own property, so the scope disappears from every
 * enumeration while still looking declared in config.yaml.
 */
test('a scope literally named __proto__ becomes an own key, not a prototype write', () => {
  const raw: Record<string, unknown> = Object.create(null);
  raw['__proto__'] = ['/nowhere/proto'];

  const scopes = parseScopesConfig(raw, 'config.yaml');
  assert.deepEqual(Object.keys(scopes ?? {}), ['__proto__']);
  assert.equal(
    resolveScopeForCwd(scopes, '/nowhere/proto/service'),
    '__proto__',
    'a scope that survives parsing must also claim its directories',
  );
});
