import test from 'node:test';
import assert from 'node:assert/strict';
import { runRemember } from '../src/commands/remember.js';
import { runSupersede } from '../src/commands/supersede.js';
import {
  CLAIM_SIMILARITY_THRESHOLD,
  claimIdentifiers,
  claimShape,
  claimSimilarity,
  newIdentifiers,
  sameClaim,
} from '../src/lib/similarity.js';
import { MemspecStore } from '../src/lib/store.js';
import { makeTempProject, runCli } from './helpers.js';

/**
 * Claims that name different identifiers are different claims. The weighted
 * lexical similarity reads a shared template as the claim ("`A` in a.ts is
 * set to 2" vs "`B` in a.ts is set to 3" scores 0.68), so the near-duplicate
 * band (and the tombstone's threshold path) also compare identifiers.
 * Fixtures follow the wrongness benchmark's phrasing
 * (scripts/bench-wrongness/phrasing.mjs, template 0).
 */

type Claim = { title: string; body: string };
const AT = 'at hono 0123456789ab';
const claim = (title: string, value: string, from: string): Claim => ({
  title,
  body: `${title}. Full value: ${value}. Read from ${from} ${AT}.`,
});
const constant = (name: string, file: string, value: string) => claim(`\`${name}\` in ${file} is set to ${value}`, value, file);
const exportOf = (name: string, file: string) => claim(`${file} exports \`${name}\` as a runtime value`, 'value', file);
const signature = (name: string, file: string, params: string) => claim(`\`${name}\` in ${file} takes parameters ${params}`, params, file);
const dependency = (name: string, version: string) => claim(`package.json devDependencies: \`${name}\` is ${version}`, version, 'package.json');
const usage = (name: string, file: string, user: string) => claim(`\`${name}\` from ${file} is used by ${user}`, user, `the imports of ${user}`);

const ids = (c: Claim) => claimIdentifiers(c.title, c.body);
const ctx = (c: Claim) => claimShape(c.title, c.body);

async function project(): Promise<string> {
  const cwd = await makeTempProject();
  await runCli(['init', '--cwd', cwd]);
  return cwd;
}

// --- Identifier extraction ---------------------------------------------------

test('identifiers: backticks, code symbols, paths, numbers, versions, quoted literals, labels', () => {
  const found = claimIdentifiers(
    'Option B: `main` serves useState via HttpClient',
    "STASH_EFFECT and session.ttl in config/cache.yaml; port 5433, v1.2.3, ^4.17.21, 30-minute TTL, value '_hp' and \"two words\".",
  );
  for (const id of ['#b', '~main', 'useState', 'HttpClient', 'STASH_EFFECT', 'session.ttl', 'config/cache.yaml', '~5433', '1.2.3', '4.17.21', '~30-minute', '_hp', '~two words']) {
    assert.ok(found.has(id), `missing ${id} in ${[...found].join(', ')}`);
  }
});

test('identifiers: prose is not an identifier (sentence-initial A, pronoun I, slash pairs, e.g., capitalised words)', () => {
  const found = claimIdentifiers('A deploy runs read/write and/or TCP/UDP checks', 'I think Postgres is fine, e.g. for staging. Hono\'s pin is fine.');
  assert.deepEqual([...found], []);
});

test('true paraphrases name the same identifiers, both directions (similarity fixtures)', () => {
  const pairs: Array<[Claim, Claim]> = [
    [
      { title: 'Postgres primary listens on port 5433', body: 'The primary database is on 5433, not the default 5432.' },
      { title: 'Primary Postgres port is 5433', body: 'Database primary listens on 5433 instead of default 5432.' },
    ],
    [
      { title: 'Nightly backup job runs at 02:00 UTC', body: 'The backup cron fires at 02:00 UTC and uploads to the backups bucket.' },
      { title: 'Backup cron schedule: 02:00 UTC nightly', body: 'Nightly at 02:00 UTC the backup cron runs and uploads to the backups bucket.' },
    ],
    [
      constant('STASH_CALLBACK', 'src/jsx/hooks/index.ts', '2'),
      { title: 'In src/jsx/hooks/index.ts, STASH_CALLBACK is set to 2', body: 'STASH_CALLBACK (src/jsx/hooks/index.ts) has the value 2. Read from the source at hono 0123456789ab.' },
    ],
  ];
  for (const [a, b] of pairs) {
    assert.ok(claimSimilarity(a, b) >= CLAIM_SIMILARITY_THRESHOLD, `${a.title} vs ${b.title}`);
    assert.deepEqual(newIdentifiers(ids(a), ctx(b)), [], `${a.title} -> ${b.title}`);
    assert.deepEqual(newIdentifiers(ids(b), ctx(a)), [], `${b.title} -> ${a.title}`);
    assert.ok(sameClaim(ctx(a), ctx(b)) && sameClaim(ctx(b), ctx(a)), `wording: ${a.title} vs ${b.title}`);
  }
});

test('a word inside a path or a symbol is not a standalone mention of that word', () => {
  const record = ctx(claim("`Style` is importable from 'hono/css'", 'value', 'package.json exports'));
  assert.deepEqual(newIdentifiers(ids(claim("`css` is importable from 'hono/css'", 'value', 'package.json exports')), record), ['css']);
  const symbols = ctx(constant('PSEUDO_GLOBAL_SELECTOR', 'src/helper/css/common.ts', "':-hono-global'"));
  assert.deepEqual(newIdentifiers(['~selectors'], symbols), ['selectors']);
  // A stopword-spelled export is still a name.
  assert.deepEqual(newIdentifiers(['~some'], ctx(claim('`every` is importable from \'hono/combine\'', 'value', 'package.json exports'))), ['some']);
  assert.deepEqual(newIdentifiers(['~main'], ctx({ title: 'Deploys run from main', body: 'Only main deploys.' })), []);
});

test('code is case-sensitive; a module specifier is not the folder of another; both titles must be covered', () => {
  assert.deepEqual(newIdentifiers(ids(exportOf('jsx', 'src/jsx/base.ts')), ctx(claim('src/jsx/base.ts exports `JSX` as a namespace', 'namespace', 'src/jsx/base.ts'))), ['jsx']);
  assert.deepEqual(newIdentifiers(['hono/jsx'], { ids: ['hono/jsx/dom'] }), ['hono/jsx']);
  // 'hono' is mentioned by the plain word in "at hono <sha>", but the record's
  // title names 'hono/types', which the incoming claim never mentions.
  const fromRoot = ctx(claim("`Next` is importable from 'hono'", 'value', 'package.json exports'));
  const fromTypes = ctx(claim("`Next` is importable from 'hono/types'", 'value', 'package.json exports'));
  assert.deepEqual(newIdentifiers(fromRoot.titleIds, fromTypes), []);
  assert.deepEqual(newIdentifiers(fromTypes.titleIds, fromRoot), ['hono/types']);
  assert.equal(sameClaim(fromRoot, fromTypes), false);
  assert.equal(sameClaim(fromTypes, fromRoot), false);
});

test('the same identifiers with different wording is a different claim (a signature is not an export)', () => {
  const sig = signature('getProcessor', 'src/adapter/aws-lambda/handler.ts', '(event)');
  const exp = exportOf('getProcessor', 'src/adapter/aws-lambda/handler.ts');
  assert.ok(claimSimilarity(sig, exp) >= CLAIM_SIMILARITY_THRESHOLD);
  assert.deepEqual(newIdentifiers(claimShape(sig.title).ids, ctx(exp)), []);
  assert.equal(sameClaim(ctx(sig), ctx(exp)), false);
  // Wording too thin to say anything beyond the identifiers: identifiers decide.
  assert.equal(sameClaim(ctx({ title: '`MAX_DEPTH` = 3', body: '' }), ctx({ title: '`MAX_DEPTH` is 3', body: '' })), true);
});

test('identifiers: provenance pointers (dates, commits, memspec ids) are not what a claim is about', () => {
  const found = claimIdentifiers('Decided 2026-09-21/22 (ms_01M4WWBHGGNQ4NHMWKFY69Y3QB)', 'Shipped at commit 4fa8c3c on 2026-10-26T10:00:00Z, ULID 01M4WWBHGGNQ4NHMWKFY69Y3QB.');
  assert.deepEqual([...found], []);
});

test('a directory path is mentioned by a claim naming a file inside it', () => {
  assert.deepEqual(newIdentifiers(['/srv/tool-config'], { ids: ['/srv/tool-config/.cache/state.json'] }), []);
  assert.deepEqual(newIdentifiers(['/srv/other-config'], { ids: ['/srv/tool-config/.cache/state.json'] }), ['/srv/other-config']);
  // A file inside a mentioned directory is more specific: a new identifier.
  assert.deepEqual(newIdentifiers(['/srv/tool-config/state.json'], { ids: ['/srv/tool-config'] }), ['/srv/tool-config/state.json']);
});

test('a file path matches the same file named by a shorter or longer path, never another file', () => {
  const long = { ids: ['src/jsx/hooks/index.ts'] };
  assert.deepEqual(newIdentifiers(['hooks/index.ts'], long), []);
  assert.deepEqual(newIdentifiers(['index.ts'], long), []);
  assert.deepEqual(newIdentifiers(['src/jsx/dom/index.ts'], long), ['src/jsx/dom/index.ts']);
  assert.deepEqual(newIdentifiers(['src/jsx/hooks/index.tsx'], long), ['src/jsx/hooks/index.tsx']);
  // An entry indexed before identifiers existed grants no exemption.
  assert.deepEqual(newIdentifiers(['anything'], {}), []);
});

// --- The near-duplicate band through remember ---------------------------------

const TEMPLATED: Array<[string, Claim, Claim]> = [
  ['constants in one file', constant('STASH_CALLBACK', 'src/jsx/hooks/index.ts', '2'), constant('STASH_EFFECT', 'src/jsx/hooks/index.ts', '3')],
  ['constants, same value', constant('STASH_REF', 'src/jsx/hooks/index.ts', '4'), constant('STASH_MEMO', 'src/jsx/hooks/index.ts', '4')],
  ['exports of one module', exportOf('createContext', 'src/jsx/context.ts'), exportOf('useContext', 'src/jsx/context.ts')],
  ['signatures', signature('render', 'src/jsx/dom/render.ts', '(jsxNode: Node, container: Container)'), signature('flushSync', 'src/jsx/dom/render.ts', '(callback: () => void)')],
  ['one export, different files', exportOf('HtmlEscapedString', 'src/utils/html.ts'), exportOf('HtmlEscapedString', 'src/helper/html/index.ts')],
  ['dependency versions', dependency('@types/crypto-js', '^4.1.1'), dependency('@types/jsdom', '^4.1.3')],
  ['usages by different files', usage('compose', 'src/compose.ts', 'src/hono-base.ts'), usage('compose', 'src/compose.ts', 'src/preset/tiny.ts')],
  ['signature and export of one symbol', exportOf('getProcessor', 'src/adapter/aws-lambda/handler.ts'), signature('getProcessor', 'src/adapter/aws-lambda/handler.ts', '(event)')],
  ['public API entry points', claim("`Style` is importable from 'hono/css'", 'value', 'package.json exports and src/helper/css/index.ts'), claim("`css` is importable from 'hono/css'", 'value', 'package.json exports and src/helper/css/index.ts')],
];

test('templated facts that name different identifiers are written (they share the template, not the claim)', async () => {
  for (const [name, first, second] of TEMPLATED) {
    // The pair is lexically a near-duplicate: without identifiers it was refused.
    assert.ok(claimSimilarity(first, second) >= CLAIM_SIMILARITY_THRESHOLD, `${name}: ${claimSimilarity(first, second).toFixed(2)}`);
    const cwd = await project();
    runRemember('fact', first.title, { cwd, body: first.body, source: 'agent-a' });
    const written = runRemember('fact', second.title, { cwd, body: second.body, source: 'agent-a' });
    assert.ok(written.id, name);
    assert.equal(new MemspecStore(cwd).loadActive().length, 2, name);
  }
});

test('a value change on the same identifier is not a near-duplicate', async () => {
  const cwd = await project();
  const two = constant('MAX_DEPTH', 'src/router/trie.ts', '2');
  const three = constant('MAX_DEPTH', 'src/router/trie.ts', '3');
  assert.ok(claimSimilarity(two, three) >= CLAIM_SIMILARITY_THRESHOLD);
  runRemember('fact', two.title, { cwd, body: two.body, source: 'agent-a' });
  assert.ok(runRemember('fact', three.title, { cwd, body: three.body, source: 'agent-b' }).id);
});

test('a paraphrase naming the same identifiers is still refused, and so is a less specific restatement', async () => {
  const cwd = await project();
  const original = constant('STASH_CALLBACK', 'src/jsx/hooks/index.ts', '2');
  const first = runRemember('fact', original.title, { cwd, body: original.body, source: 'agent-a' });
  const reworded = {
    title: 'In src/jsx/hooks/index.ts, STASH_CALLBACK is set to 2',
    body: 'STASH_CALLBACK (src/jsx/hooks/index.ts) has the value 2. Read from the source at hono 0123456789ab.',
  };
  const lessSpecific = { title: '`STASH_CALLBACK` is set to 2', body: '`STASH_CALLBACK` is set to 2. Full value: 2. Read from hooks/index.ts at hono 0123456789ab.' };
  for (const c of [reworded, lessSpecific]) {
    assert.ok(claimSimilarity(c, original) >= CLAIM_SIMILARITY_THRESHOLD, c.title);
    assert.throws(
      () => runRemember('fact', c.title, { cwd, body: c.body, source: 'agent-b' }),
      (err: Error) => err.message.startsWith('remember refuses near-duplicate: an active fact making the same claim') && err.message.includes(first.id),
    );
  }
  assert.equal(new MemspecStore(cwd).loadActive().length, 1);
});

test('a twin that only adds body detail (a commit, another symbol) is still refused: the title names the claim', async () => {
  const cwd = await project();
  const original = constant('STASH_CALLBACK', 'src/jsx/hooks/index.ts', '2');
  const first = runRemember('fact', original.title, { cwd, body: original.body, source: 'agent-a' });
  const twin = { title: original.title, body: `${original.body} Read by useMemo (4fa8c3c).` };
  assert.ok(claimSimilarity(twin, original) >= CLAIM_SIMILARITY_THRESHOLD);
  assert.throws(
    () => runRemember('fact', `${twin.title} (re-checked)`, { cwd, body: twin.body, source: 'agent-b' }),
    (err: Error) => err.message.startsWith('remember refuses near-duplicate: an active fact making the same claim') && err.message.includes(first.id),
  );
});

// --- The tombstone's threshold path ------------------------------------------

test('tombstone: a templated claim about another identifier is not a re-assertion of a rejected value', async () => {
  const cwd = await project();
  const old = constant('STASH_CALLBACK', 'src/jsx/hooks/index.ts', '2');
  const fixed = constant('STASH_CALLBACK', 'src/jsx/hooks/index.ts', '3');
  const a = runRemember('fact', old.title, { cwd, body: old.body, source: 'agent-a' });
  runSupersede(a.id, { cwd, reason: 'value is 3', title: fixed.title, body: fixed.body, source: 'agent-a' });
  // Same wording, same rejected number, different constant: written.
  const other = constant('STASH_EFFECT', 'src/jsx/hooks/index.ts', '2');
  assert.ok(claimSimilarity(other, old) >= CLAIM_SIMILARITY_THRESHOLD);
  assert.ok(runRemember('fact', other.title, { cwd, body: other.body, source: 'agent-b', channel: 'mcp' }).id);
  // The rejected value itself, and with an added identifier, still refuse.
  const padded = { title: old.title, body: `${old.body} Also set in config/hooks.yaml.` };
  for (const c of [old, padded]) {
    assert.throws(
      () => runRemember('decision', c.title, { cwd, body: c.body, source: 'agent-b', channel: 'mcp' }),
      new RegExp(`remember refuses rejected value: this value was rejected in ${a.id}`),
    );
  }
});

test('tombstone: a retraction still refuses its own claim, not a templated claim about another identifier', async () => {
  const cwd = await project();
  const old = constant('HONO_PORTAL_ELEMENT', 'src/jsx/dom/render.ts', "'_hp'");
  const a = runRemember('fact', old.title, { cwd, body: old.body, source: 'agent-a' });
  runSupersede(a.id, { cwd, reason: 'constant was removed', source: 'agent-a' });
  assert.throws(
    () => runRemember('fact', old.title, { cwd, body: old.body, source: 'agent-b', channel: 'mcp' }),
    new RegExp(`rejected in ${a.id} .*retracted with no replacement`),
  );
  const other = constant('HONO_ELEMENT_ID', 'src/jsx/dom/render.ts', "'_hp'");
  assert.ok(claimSimilarity(other, old) >= CLAIM_SIMILARITY_THRESHOLD);
  assert.ok(runRemember('fact', other.title, { cwd, body: other.body, source: 'agent-b', channel: 'mcp' }).id);
});

test('tombstone: a merged piece refuses its restatement, not a templated claim about another identifier', async () => {
  const cwd = await project();
  const piece = exportOf('createContext', 'src/jsx/context.ts');
  const p = runRemember('fact', piece.title, { cwd, body: piece.body, source: 'agent-a' });
  const s = runRemember('fact', 'Context exports of the JSX runtime', { cwd, body: 'The JSX runtime context module exports its helpers.', source: 'agent-a' });
  runSupersede(s.id, { cwd, reason: 'consolidate', mergeFrom: [p.id], source: 'agent-a' });
  assert.throws(
    () => runRemember('fact', `${piece.title} (restated)`, { cwd, body: piece.body, source: 'agent-b', channel: 'mcp' }),
    /remember refuses near-duplicate: this claim restates a record consolidated by a merge/,
  );
  const other = exportOf('useContext', 'src/jsx/context.ts');
  assert.ok(runRemember('fact', other.title, { cwd, body: other.body, source: 'agent-b', channel: 'mcp' }).id);
});
