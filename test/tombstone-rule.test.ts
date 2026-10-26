import test from 'node:test';
import assert from 'node:assert/strict';
import { runRemember } from '../src/commands/remember.js';
import { runSupersede } from '../src/commands/supersede.js';
import type { ClaimIndexEntry } from '../src/lib/claim-index.js';
import { CLAIM_SIMILARITY_THRESHOLD, claimSimilarity, claimTokens, tokenWeight } from '../src/lib/similarity.js';
import { REJECTION_MARGIN, scanArchive } from '../src/lib/tombstone.js';
import { MemspecStore } from '../src/lib/store.js';
import { makeTempProject, runCli } from './helpers.js';

/**
 * The tombstone rule (lib/tombstone.ts) and the evidence for REJECTION_MARGIN.
 * Fixtures: R is the rejected record, S the survivor that replaced it.
 */

type Claim = { title: string; body: string };

const TTL = (ttl: string) =>
  `Session cache entries in the gateway expire after ${ttl} minutes. The TTL is set in config/cache.yaml under session.ttl and applies to every pod in the cluster; changing it requires a rolling restart of the gateway deployment.`;
const LONG = {
  R: { title: 'Session cache TTL is 30 minutes', body: TTL('30') },
  S: { title: 'Session cache TTL is 15 minutes', body: TTL('15') },
};
const SHORT = {
  R: { title: 'Session cache TTL is 30 minutes', body: 'Session cache entries expire after 30 minutes.' },
  S: { title: 'Session cache TTL is 15 minutes', body: 'Session cache entries expire after 15 minutes.' },
};
const STORE = (v: string) =>
  `The gateway keeps session state in ${v}. Every pod connects through the shared session client configured in config/session.yaml, and a failover drill runs monthly against the ${v} cluster.`;
// A value change carried by a word, not an identifier: the margin alone decides.
const WORD = {
  R: { title: 'Gateway session store is Redis', body: STORE('Redis') },
  S: { title: 'Gateway session store is Memcached', body: STORE('Memcached') },
};

function entry(id: string, claim: Claim, extra: Partial<ClaimIndexEntry>): ClaimIndexEntry {
  const tokens = [...claimTokens(claim.title, claim.body)];
  return { id, kind: 'claim', type: 'fact', state: 'active', title: claim.title, tokens, weight: tokenWeight(tokens), ...extra };
}

function verdict(pair: { R: Claim; S: Claim }, claim: Claim): 'refuse' | 'allow' {
  const index = [
    entry('ms_R', pair.R, { state: 'superseded', superseded_by: 'ms_S', supersede_kind: 'replace' }),
    entry('ms_S', pair.S, {}),
  ];
  const tokens = claimTokens(claim.title, claim.body);
  return scanArchive(index, { tokens, weight: tokenWeight(tokens) }).rejected.length > 0 ? 'refuse' : 'allow';
}

// [fixture, case, claim, expected]
const CASES: Array<[string, string, Claim, 'refuse' | 'allow']> = [
  ['long', 'old value verbatim', LONG.R, 'refuse'],
  ['long', 'old value with filler', { title: 'Note: session cache TTL is 30 minutes', body: `As documented in the runbook, ${TTL('30')} Checked again today by the on-call engineer.` }, 'refuse'],
  ['long', 'both values (mixed)', { title: LONG.R.title, body: `${TTL('30')} Not 15 minutes.` }, 'refuse'],
  // Lexical limit, shared with the near-duplicate band: a heavy rewording of
  // the old value scores below the threshold (0.62) and is never judged.
  ['long', 'new wording, old value (below threshold)', { title: 'Gateway session cache TTL: 30 minutes', body: 'Every gateway pod drops session cache entries 30 minutes after creation; the value lives at session.ttl in config/cache.yaml and changing it needs a rolling restart of the gateway deployment.' }, 'allow'],
  ['long', 'survivor wording, old value', { title: LONG.S.title.replace('15', '30'), body: `${TTL('30')} Applies from the config rollout onwards.` }, 'refuse'],
  ['long', 'a third value (remember: as close to S as to R)', { title: 'Session cache TTL is 20 minutes', body: TTL('20') }, 'refuse'],
  ['long', 'current value verbatim (re-typed)', LONG.S, 'allow'],
  ['long', 'current value, reworded', { title: 'Gateway session cache TTL: 15 minutes', body: 'Every gateway pod drops session cache entries 15 minutes after creation; the value lives at session.ttl in config/cache.yaml and changing it needs a rolling restart of the gateway deployment.' }, 'allow'],
  ['long', 'current value as a decision', { title: 'Keep the session cache TTL at 15 minutes', body: 'We keep session.ttl in config/cache.yaml at 15 minutes for every gateway pod in the cluster; changing it requires a rolling restart.' }, 'allow'],
  ['short', 'old value verbatim', SHORT.R, 'refuse'],
  ['short', 'old value paraphrased', { title: 'Cached sessions expire after 30 minutes', body: 'The TTL for the session cache is 30 minutes.' }, 'refuse'],
  ['short', 'both values (mixed)', { title: SHORT.R.title, body: 'Session cache entries expire after 30 minutes, not 15 minutes.' }, 'refuse'],
  ['short', 'current value verbatim', SHORT.S, 'allow'],
  ['short', 'current value paraphrased', { title: 'Cached sessions expire after 15 minutes', body: 'The TTL for the session cache is 15 minutes.' }, 'allow'],
  ['short', 'refinement of the current value', { title: 'Session cache TTL is 15 minutes in production', body: 'Production session cache entries expire after 15 minutes.' }, 'allow'],
  ['word', 'old value verbatim', WORD.R, 'refuse'],
  ['word', 'old value with filler', { title: 'Note: gateway session store is Redis', body: `Per the runbook, ${STORE('Redis')} Confirmed again during the drill.` }, 'refuse'],
  ['word', 'old value in decision wording', { title: 'Keep the gateway session store on Redis', body: 'Session state for the gateway stays in Redis; every pod connects through the shared session client in config/session.yaml and the monthly failover drill targets the Redis cluster.' }, 'refuse'],
  ['word', 'current value verbatim', WORD.S, 'allow'],
  ['word', 'current value in decision wording', { title: 'Keep the gateway session store on Memcached', body: 'Session state for the gateway stays in Memcached; every pod connects through the shared session client in config/session.yaml and the monthly failover drill targets the Memcached cluster.' }, 'allow'],
];

const PAIRS = { long: LONG, short: SHORT, word: WORD } as const;

test('margin evidence: every case gets the expected verdict, and the margin sits inside the measured gap', () => {
  let minAllowGap = Infinity;
  let maxRefuseGap = -Infinity;
  const rows: string[] = [];
  for (const [fixture, name, claim, expected] of CASES) {
    const pair = PAIRS[fixture as keyof typeof PAIRS];
    const toR = claimSimilarity(claim, pair.R);
    const toS = claimSimilarity(claim, pair.S);
    rows.push(`${fixture.padEnd(5)} ${name.padEnd(48)} toR ${toR.toFixed(2)} toS ${toS.toFixed(2)} gap ${(toS - toR).toFixed(2)} ${expected}`);
    assert.equal(verdict(pair, claim), expected, `${fixture}: ${name} (toR ${toR.toFixed(2)}, toS ${toS.toFixed(2)})`);
    if (process.env.MEMSPEC_PRINT_MARGIN) console.log(rows[rows.length - 1]);
    if (toR < CLAIM_SIMILARITY_THRESHOLD) continue; // never judged by the margin
    if (expected === 'allow') minAllowGap = Math.min(minAllowGap, toS - toR);
    else maxRefuseGap = Math.max(maxRefuseGap, toS - toR);
  }
  // Judged cases: allowed ones sit >= 0.08 closer to S, refused ones <= 0.00.
  assert.ok(minAllowGap > REJECTION_MARGIN, `smallest allowed gap ${minAllowGap.toFixed(3)}\n${rows.join('\n')}`);
  assert.ok(maxRefuseGap < REJECTION_MARGIN, `largest refused gap ${maxRefuseGap.toFixed(3)}\n${rows.join('\n')}`);
});

test('a retraction refuses whatever the claim, a merged piece is reported as merged', () => {
  const tokens = claimTokens(SHORT.R.title, SHORT.R.body);
  const incoming = { tokens, weight: tokenWeight(tokens) };
  const retracted = scanArchive([entry('ms_R', SHORT.R, { state: 'superseded', supersede_kind: 'retract' })], incoming);
  assert.equal(retracted.rejected.length, 1);
  const merged = scanArchive([
    entry('ms_R', SHORT.R, { state: 'superseded', superseded_by: 'ms_S', supersede_kind: 'merge' }),
    entry('ms_S', { title: 'Session cache facts', body: `${SHORT.R.body} The cache is backed by the shared Redis cluster.` }, {}),
  ], incoming);
  assert.equal(merged.rejected.length, 0);
  assert.equal(merged.merged[0].survivor.id, 'ms_S');
});

// --- Through the commands --------------------------------------------------

async function project(): Promise<string> {
  const cwd = await makeTempProject();
  await runCli(['init', '--cwd', cwd]);
  return cwd;
}

async function rejectedLong(): Promise<{ cwd: string; oldId: string; survivorId: string }> {
  const cwd = await project();
  const old = runRemember('fact', LONG.R.title, { cwd, body: LONG.R.body, source: 'agent-a' });
  const survivorId = runSupersede(old.id, { cwd, reason: 'lowered', title: LONG.S.title, body: LONG.S.body, source: 'agent-a' }).survivor_id;
  return { cwd, oldId: old.id, survivorId };
}

test('supersede of the current record over MCP: a third value or a rewording is written, the old value is not', async () => {
  const { cwd, oldId, survivorId } = await rejectedLong();
  const refused = new RegExp(`supersede refuses rejected value: this value was rejected in ${oldId} .*final over MCP`);
  // Verbatim, with filler, and in the survivor's words: all carry 30.
  for (const claim of [LONG.R, { title: 'Note: session cache TTL is 30 minutes', body: `As documented, ${TTL('30')}` }, { title: LONG.S.title.replace('15', '30'), body: TTL('30') }]) {
    assert.throws(() => runSupersede(survivorId, { cwd, reason: 'revert', title: claim.title, body: claim.body, source: 'agent-b', channel: 'mcp' }), refused);
  }
  assert.ok(new MemspecStore(cwd).findById(survivorId)!.state === 'active', 'survivor untouched');
  // A third value: the next correction goes through.
  const next = runSupersede(survivorId, { cwd, reason: 'lowered again', title: 'Session cache TTL is 10 minutes', body: TTL('10'), source: 'agent-b', channel: 'mcp' }).survivor_id;
  // A rewording of the current value goes through.
  runSupersede(next, { cwd, reason: 'wording', title: 'Gateway session cache TTL: 10 minutes', body: `${TTL('10')} Verified in the deployed config.`, source: 'agent-b', channel: 'mcp' });
  // Both earlier values are now rejections.
  assert.throws(() => runRemember('decision', LONG.S.title, { cwd, body: LONG.S.body, source: 'agent-c', channel: 'mcp' }), /remember refuses rejected value/);
  assert.throws(() => runRemember('decision', LONG.R.title, { cwd, body: LONG.R.body, source: 'agent-c', channel: 'mcp' }), new RegExp(`rejected in ${oldId}`));
});

test('supersede of the current record over MCP: a word-valued revert with filler is refused, a third value is written', async () => {
  const cwd = await project();
  const old = runRemember('fact', WORD.R.title, { cwd, body: WORD.R.body, source: 'agent-a' });
  const s = runSupersede(old.id, { cwd, reason: 'migrated', title: WORD.S.title, body: WORD.S.body, source: 'agent-a' }).survivor_id;
  assert.throws(
    () => runSupersede(s, { cwd, reason: 'revert', title: 'Note: gateway session store is Redis', body: `Per the runbook, ${STORE('Redis')} Confirmed again during the drill.`, source: 'agent-b', channel: 'mcp' }),
    new RegExp(`supersede refuses rejected value: this value was rejected in ${old.id}`),
  );
  const third = runSupersede(s, { cwd, reason: 'migrated again', title: 'Gateway session store is Valkey', body: STORE('Valkey'), source: 'agent-b', channel: 'mcp' });
  assert.ok(new MemspecStore(cwd).findById(third.survivor_id));
});

test('supersede over MCP: a body restating a merged piece of another survivor is refused as a near-duplicate', async () => {
  const cwd = await project();
  const holder = runRemember('fact', 'Session cache is backed by Redis', { cwd, body: 'Session cache entries live in the shared Redis cluster.', source: 'agent-a' });
  const piece = runRemember('fact', SHORT.R.title, { cwd, body: SHORT.R.body, source: 'agent-a' });
  runSupersede(holder.id, { cwd, reason: 'fold the TTL in', mergeFrom: [piece.id], source: 'agent-a' });
  const x = runRemember('fact', 'Build runner uses 4 vCPU', { cwd, body: 'CI runners are provisioned with 4 vCPU and 16 GB.', source: 'agent-b' });
  assert.throws(
    () => runSupersede(x.id, { cwd, reason: 'wrong', title: SHORT.R.title, body: SHORT.R.body, source: 'agent-b', channel: 'mcp' }),
    (err: Error) => err.message.startsWith('supersede refuses near-duplicate:') && err.message.includes(`merged into the active fact ${holder.id}`) && !/rejected value/.test(err.message),
  );
  // The holder itself can be rewritten with the piece in it (the write holds it).
  const rewritten = runSupersede(holder.id, {
    cwd, reason: 'restructure', title: 'Session cache facts', body: `${SHORT.R.body} Session cache entries live in the shared Redis cluster.`, source: 'agent-b', channel: 'mcp',
  });
  assert.ok(new MemspecStore(cwd).findById(rewritten.survivor_id));
});

test('remember: a refinement carrying the old number in the survivor wording is refused; the CLI override logs it', async () => {
  const { cwd, oldId, survivorId } = await rejectedLong();
  const claim = { title: 'Session cache TTL is 15 minutes (was 30)', body: `${TTL('15')} It was 30 minutes before the rollout.` };
  assert.throws(
    () => runRemember('fact', claim.title, { cwd, body: claim.body, source: 'agent-b', channel: 'mcp', refines: [survivorId] }),
    (err: Error) => err.message.includes(`rejected in ${oldId}`) && err.message.includes('carries 30, which the correction removed'),
  );
  const written = runRemember('fact', claim.title, { cwd, body: claim.body, source: 'human:op', channel: 'cli', refines: [survivorId], allowRejected: true });
  const log = new MemspecStore(cwd).findById(written.id)!.ext?.rejected_value_overrides as Array<Record<string, unknown>>;
  assert.deepEqual(log[0].removed_values, ['30']);
});
