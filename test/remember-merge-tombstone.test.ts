import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runRemember } from '../src/commands/remember.js';
import { runSupersede } from '../src/commands/supersede.js';
import { CLAIM_SIMILARITY_THRESHOLD, claimSimilarity } from '../src/lib/similarity.js';
import { MemspecStore } from '../src/lib/store.js';
import { McpSession } from './mcp-session.js';
import { makeTempProject, REPO_ROOT, runCli } from './helpers.js';

/**
 * A merge is consolidation, not rejection, per record: every `merge_from` id
 * (with or without a replacement body) is stamped `merge`, and re-remembering
 * it is a near-duplicate of the survivor (update it), never "this value was
 * rejected". The TARGET of a supersede with a replacement body is stamped
 * `replace`: its value is what the body corrects, and it keeps the tombstone,
 * as do retractions.
 */

const A = { title: 'Gateway uses mTLS for upstream authentication', body: 'Every upstream call from the gateway presents a client certificate.' };
const B = { title: 'Gateway retries failed upstream requests three times', body: 'A failed request to an upstream is retried 3 times with exponential backoff before the gateway gives up.' };
const C = { title: 'Gateway access logs ship to the central log cluster', body: 'Request logs from the gateway are forwarded to the shared Loki cluster within 30 seconds.' };
const PAIR = { title: 'Edge proxy behaviour', body: `${A.body}\n${B.body}` };
const UNION = {
  title: 'Edge proxy behaviour',
  body: `${A.body}\n${B.body}\n${C.body}`,
};

async function project(): Promise<string> {
  const cwd = await makeTempProject();
  await runCli(['init', '--cwd', cwd]);
  return cwd;
}

function remember(cwd: string, piece: { title: string; body: string }, channel: 'cli' | 'mcp' = 'mcp') {
  return runRemember('fact', piece.title, { cwd, body: piece.body, source: 'agent-a', channel });
}

/** The tombstone refusal for a collapsed piece, naming the survivor that replaced it. */
function isRejectedInto(pieceId: string, survivorId: string) {
  return (err: Error) =>
    err.message.startsWith('remember refuses rejected value:') &&
    err.message.includes(`this value was rejected in ${pieceId}`) &&
    err.message.includes(`superseded by ${survivorId}`);
}

/** The near-duplicate-of-survivor refusal, never the tombstone. */
function isMergedNearDuplicate(pieceId: string, survivorId: string) {
  return (err: Error) =>
    err.message.startsWith('remember refuses near-duplicate:') &&
    err.message.includes(`${pieceId}`) &&
    err.message.includes(`merged into the active fact ${survivorId}`) &&
    err.message.includes(`memspec supersede ${survivorId}`) &&
    !/rejected/.test(err.message);
}

test('fixture sanity: the pieces are distinct claims and each sits below the threshold against the union', () => {
  assert.ok(claimSimilarity(A, B) < CLAIM_SIMILARITY_THRESHOLD);
  assert.ok(claimSimilarity(A, C) < CLAIM_SIMILARITY_THRESHOLD);
  for (const piece of [A, B, C]) {
    assert.ok(claimSimilarity(piece, UNION) < CLAIM_SIMILARITY_THRESHOLD, `${piece.title} vs union`);
  }
  for (const piece of [A, B]) {
    assert.ok(claimSimilarity(piece, PAIR) < CLAIM_SIMILARITY_THRESHOLD, `${piece.title} vs pair`);
  }
});

test('a replacement body with merge_from: the target is replaced, each merge_from id is merged', async () => {
  const cwd = await project();
  const a = remember(cwd, A);
  const b = remember(cwd, B);
  const survivor = runSupersede(a.id, {
    cwd, reason: 'consolidate gateway upstream facts', title: PAIR.title, body: PAIR.body, mergeFrom: [b.id], source: 'agent-a', channel: 'mcp',
  }).survivor_id;

  const store = new MemspecStore(cwd);
  assert.equal(store.findById(a.id)!.ext?.supersede_kind, 'replace');
  assert.equal(store.findById(b.id)!.ext?.supersede_kind, 'merge');

  assert.throws(() => remember(cwd, A), isRejectedInto(a.id, survivor));
  assert.throws(() => remember(cwd, B), isMergedNearDuplicate(b.id, survivor));
  // Over MCP a declared edge to the survivor exempts neither.
  assert.throws(() => runRemember('fact', A.title, { cwd, body: A.body, source: 'agent-a', channel: 'mcp', distinctFrom: [survivor] }), isRejectedInto(a.id, survivor));
  assert.throws(() => runRemember('fact', B.title, { cwd, body: B.body, source: 'agent-a', channel: 'mcp', distinctFrom: [survivor] }), isMergedNearDuplicate(b.id, survivor));
  assert.equal(new MemspecStore(cwd).loadActive().length, 1, 'nothing written');
});

test('merge into an existing survivor (one record, no body): the merged piece is a near-duplicate of the survivor', async () => {
  // The survivor ends up with supersedes: [b] (length 1), so only the marker
  // on the archived record tells this merge from a replacement.
  const cwd = await project();
  const a = remember(cwd, A);
  const b = remember(cwd, B);
  runSupersede(a.id, { cwd, reason: 'fold retry policy into the gateway fact', mergeFrom: [b.id], source: 'agent-a', channel: 'mcp' });
  assert.deepEqual(new MemspecStore(cwd).findById(a.id)!.supersedes, [b.id]);

  assert.throws(() => remember(cwd, B), isMergedNearDuplicate(b.id, a.id));
});

test('a declared edge to the survivor exempts the merged piece on the CLI only; over MCP the refusal is final', async () => {
  const cwd = await project();
  const a = remember(cwd, A);
  const b = remember(cwd, B);
  runSupersede(a.id, { cwd, reason: 'fold', mergeFrom: [b.id], source: 'agent-a' });
  assert.throws(
    () => runRemember('fact', B.title, { cwd, body: B.body, source: 'agent-a', channel: 'mcp', refines: [a.id] }),
    (err: Error) => isMergedNearDuplicate(b.id, a.id)(err) && /final/.test(err.message),
  );
  const child = runRemember('fact', B.title, { cwd, body: B.body, source: 'human:op', channel: 'cli', refines: [a.id] });
  assert.ok(new MemspecStore(cwd).findById(child.id));
});

test('dream-style merge of 3 records: summary body + merge_from merges the pieces and replaces the target', async () => {
  // Shape 1: one call, fresh survivor with a summary body, merge_from of 3
  // (the target named again in merge_from is ignored, as before).
  const cwd = await project();
  const pieces = [A, B, C].map((p) => remember(cwd, p));
  const survivor = runSupersede(pieces[0].id, {
    cwd, reason: 'dream: consolidate 3 gateway facts', title: UNION.title, body: UNION.body,
    mergeFrom: pieces.map((p) => p.id), source: 'dream', channel: 'mcp',
  }).survivor_id;
  const kinds = pieces.map((p) => new MemspecStore(cwd).findById(p.id)!.ext?.supersede_kind);
  assert.deepEqual(kinds, ['replace', 'merge', 'merge']);
  assert.throws(() => remember(cwd, A), isRejectedInto(pieces[0].id, survivor));
  for (const [i, p] of [B, C].entries()) {
    assert.throws(() => remember(cwd, p), isMergedNearDuplicate(pieces[i + 1].id, survivor));
  }
  // A reworded restatement of a merged piece: still the merge refusal, never "rejected".
  assert.throws(
    () => remember(cwd, { title: 'Gateway retries a failed upstream request 3 times', body: 'Failed upstream requests are retried three times (3) with exponential backoff before the gateway gives up.' }),
    isMergedNearDuplicate(pieces[1].id, survivor),
  );
  // Restating the summary itself is a twin of the active survivor.
  assert.throws(() => remember(cwd, { title: 'Edge proxy behaviour summary', body: UNION.body }), /remember refuses near-duplicate: an active fact/);

  // Shape 2: two pieces merged into the third, which survives.
  const cwd2 = await project();
  const pieces2 = [A, B, C].map((p) => remember(cwd2, p));
  runSupersede(pieces2[0].id, { cwd: cwd2, reason: 'dream: consolidate', mergeFrom: [pieces2[1].id, pieces2[2].id], source: 'dream', channel: 'mcp' });
  assert.throws(() => remember(cwd2, B), isMergedNearDuplicate(pieces2[1].id, pieces2[0].id));
  assert.throws(() => remember(cwd2, C), isMergedNearDuplicate(pieces2[2].id, pieces2[0].id));
});

test('a record archived before the marker existed counts as rejected, whatever its survivor supersedes', async () => {
  // The legacy "successor supersedes several records" inference is gone: any
  // later merge into that successor would lengthen the list and turn an old
  // rejection into a merge. Unmarked archives fail closed.
  const cwd = await project();
  const a = remember(cwd, A);
  const b = remember(cwd, B);
  const c = remember(cwd, C);
  runSupersede(a.id, { cwd, reason: 'consolidate', mergeFrom: [b.id, c.id], source: 'agent-a' });
  const survivor = a.id;
  // Strip the marker from the archived piece, as a pre-marker store has it.
  const path = join(cwd, '.memspec', 'archive', `${b.id}.md`);
  const text = readFileSync(path, 'utf8');
  const stripped = text.replace(/^ext:\n(?: {2}.*\n)+/m, '');
  assert.notEqual(stripped, text, 'marker removed');
  writeFileSync(path, stripped);
  assert.equal(new MemspecStore(cwd).findById(b.id)!.ext?.supersede_kind, undefined);
  assert.equal(new MemspecStore(cwd).findById(survivor)!.supersedes!.length, 2);

  assert.throws(() => remember(cwd, B), isRejectedInto(b.id, survivor));
  // The marked sibling is still consolidation.
  assert.throws(() => remember(cwd, C), isMergedNearDuplicate(c.id, survivor));
});

test('replace and retract keep the tombstone and carry their own marker', async () => {
  const cwd = await project();
  const old = remember(cwd, { title: 'Session cache TTL is 30 minutes', body: 'Session cache entries expire after 30 minutes.' });
  const survivor = runSupersede(old.id, {
    cwd, reason: 'lowered', title: 'Session cache TTL is 15 minutes', body: 'Session cache entries expire after 15 minutes.', source: 'agent-a',
  }).survivor_id;
  assert.equal(new MemspecStore(cwd).findById(old.id)!.ext?.supersede_kind, 'replace');
  assert.throws(
    () => remember(cwd, { title: 'Session cache TTL is 30 minutes', body: 'Session cache entries expire after 30 minutes.' }),
    new RegExp(`remember refuses rejected value: this value was rejected in ${old.id} .*superseded by ${survivor}.*final over MCP`),
  );

  const gone = remember(cwd, A);
  runSupersede(gone.id, { cwd, reason: 'mTLS was removed', source: 'agent-a' });
  assert.equal(new MemspecStore(cwd).findById(gone.id)!.ext?.supersede_kind, 'retract');
  assert.throws(() => remember(cwd, A), /remember refuses rejected value: .*retracted with no replacement/);
});

test('a replaced record whose successor later absorbs a merge is still a rejected value', async () => {
  // successor.supersedes ends up [old, merged] (length 2); the marker on the
  // replaced record keeps it a rejection.
  const cwd = await project();
  const old = remember(cwd, { title: 'Session cache TTL is 30 minutes', body: 'Session cache entries expire after 30 minutes.' });
  const successor = runSupersede(old.id, {
    cwd, reason: 'lowered', title: 'Session cache TTL is 15 minutes', body: 'Session cache entries expire after 15 minutes.', source: 'agent-a',
  }).survivor_id;
  const extra = remember(cwd, { title: 'Session cache is backed by Redis', body: 'Session cache entries live in the shared Redis cluster.' });
  runSupersede(successor, { cwd, reason: 'fold', mergeFrom: [extra.id], source: 'agent-a' });
  assert.equal(new MemspecStore(cwd).findById(successor)!.supersedes!.length, 2);

  assert.throws(
    () => remember(cwd, { title: 'Session cache TTL is 30 minutes', body: 'Session cache entries expire after 30 minutes.' }),
    new RegExp(`remember refuses rejected value: this value was rejected in ${old.id}`),
  );
});

test('memspec_remember MCP tool: a merged piece comes back as a near-duplicate of the survivor', async () => {
  const cwd = await project();
  const a = remember(cwd, A);
  const b = remember(cwd, B);
  runSupersede(b.id, { cwd, reason: 'consolidate', mergeFrom: [a.id], source: 'agent-a', channel: 'mcp' });
  const survivor = b.id;

  const session = new McpSession([join(REPO_ROOT, 'src/mcp.ts'), '--cwd', cwd]);
  try {
    await session.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'memspec-test', version: '0.0.0' },
    });
    session.notify('notifications/initialized', {});
    const call = await session.request('tools/call', {
      name: 'memspec_remember',
      arguments: { type: 'fact', title: A.title, body: A.body, source: 'agent-b' },
    });
    const result = call.result as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(result.isError, true);
    assert.ok(isMergedNearDuplicate(a.id, survivor)(new Error(result.content[0].text.replace(/^Error: /, ''))), result.content[0].text);
  } finally {
    await session.close();
  }
});
