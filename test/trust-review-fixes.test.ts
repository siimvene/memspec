import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, utimesSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { runAnchor } from '../src/commands/anchor.js';
import { runQuestion } from '../src/commands/question.js';
import { runReconcile } from '../src/commands/reconcile.js';
import { runRelate, runUnrelate } from '../src/commands/relate.js';
import { runRemember } from '../src/commands/remember.js';
import { runSupersede } from '../src/commands/supersede.js';
import { runVerify } from '../src/commands/verify.js';
import { withFileLock } from '../src/lib/lock.js';
import { claimSimilarity, CLAIM_SIMILARITY_THRESHOLD } from '../src/lib/similarity.js';
import { effectiveSourceKind } from '../src/lib/source.js';
import { MemspecStore } from '../src/lib/store.js';
import { McpSession } from './mcp-session.js';
import { makeTempProject, REPO_ROOT, runCli } from './helpers.js';

/**
 * Review round on the trust gates: operator authority derives from the
 * channel on every MCP write path, the tombstone fails closed, and the
 * check-then-write sections are serialized.
 */

const execFileAsync = promisify(execFile);

const OLD = { title: 'Session cache TTL is 30 minutes', body: 'Session cache entries expire after 30 minutes.' };
const NEW = { title: 'Session cache TTL is 15 minutes', body: 'Session cache entries expire after 15 minutes.' };
const OTHER = { title: 'Session cache is backed by Redis', body: 'Session cache entries live in the shared Redis cluster.' };

async function project(): Promise<string> {
  const cwd = await makeTempProject();
  await runCli(['init', '--cwd', cwd]);
  return cwd;
}

function rec(cwd: string, id: string) {
  return new MemspecStore(cwd).findById(id)!;
}

const NOT_OVER_MCP = /operator-sourced .*not available over MCP/;

async function withLockWait<T>(ms: number, fn: () => Promise<T> | T): Promise<T> {
  const prev = process.env.MEMSPEC_LOCK_WAIT_MS;
  process.env.MEMSPEC_LOCK_WAIT_MS = String(ms);
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.MEMSPEC_LOCK_WAIT_MS;
    else process.env.MEMSPEC_LOCK_WAIT_MS = prev;
  }
}

// --- Operator authority over MCP ------------------------------------------

test('MCP remember: an operator-pattern source is stored at agent tier, the claim kept in ext.claimed_source', async () => {
  const cwd = await project();
  const claims: Array<[string, string, string]> = [
    ['siim', 'Deploys happen on Tuesday afternoons', 'Production deploys are scheduled for Tuesday at 14:00 UTC.'],
    ['user', 'Backups are kept for ninety days', 'Nightly database backups are retained for 90 days in cold storage.'],
    ['human:op', 'The staging cluster runs three nodes', 'Staging Kubernetes has 3 worker nodes in one availability zone.'],
  ];
  for (const [claimed, title, body] of claims) {
    const r = runRemember('fact', title, { cwd, body, source: claimed, channel: 'mcp' });
    const item = rec(cwd, r.id);
    assert.equal(item.source, `mcp:${claimed}`);
    assert.equal(item.source_kind, 'agent');
    assert.equal(effectiveSourceKind(item), 'agent');
    assert.notEqual(item.verified_with, 'operator');
    assert.equal(item.ext?.claimed_source, claimed);
    assert.ok(!r.filePath.includes(`${join('memory', 'operator')}`), 'not written to the operator tier');
    assert.match(r.message, /names an operator, but operator tier is not available over MCP/);
    assert.equal(r.source, `mcp:${claimed}`);
    // Not unfixable: an agent can supersede it over MCP.
    runSupersede(r.id, { cwd, reason: 'wrong', channel: 'mcp', source: 'agent-a' });
  }
  // The CLI channel is unchanged.
  const cli = runRemember('fact', 'Billing runs on the first of the month', { cwd, body: 'operator note', source: 'siim', channel: 'cli' });
  assert.equal(rec(cwd, cli.id).source_kind, 'operator');
  assert.equal(rec(cwd, cli.id).verified_with, 'operator');
});

test('MCP supersede: a replacement source naming an operator is stored at agent tier', async () => {
  const cwd = await project();
  const a = runRemember('fact', OLD.title, { cwd, body: OLD.body, source: 'agent-a' });
  const res = runSupersede(a.id, { cwd, reason: 'lowered', title: NEW.title, body: NEW.body, source: 'human:op', channel: 'mcp' });
  const survivor = rec(cwd, res.survivor_id);
  assert.equal(survivor.source, 'mcp:human:op');
  assert.equal(effectiveSourceKind(survivor), 'agent');
  assert.equal(survivor.ext?.claimed_source, 'human:op');
  assert.match(res.source_warning ?? '', /names an operator/);
  // and stays correctable over MCP
  runSupersede(survivor.id, { cwd, reason: 'retract', channel: 'mcp', source: 'agent-a' });
});

test('MCP verify: an operator-pattern source never yields verified_with operator; history keeps the claim', async () => {
  const cwd = await project();
  const a = runRemember('fact', OTHER.title, { cwd, body: OTHER.body, source: 'agent-a' });
  const res = runVerify(a.id, { cwd, evidence: 'checked the cluster config', source: 'siim', channel: 'mcp' });
  assert.equal(res.verified_with, 'evidence');
  const ext = rec(cwd, a.id).ext as Record<string, Record<string, unknown>>;
  assert.equal(ext.last_verification.source, 'mcp:siim');
  assert.equal(ext.last_verification.claimed_source, 'siim');
  assert.match(res.source_warning ?? '', /names an operator/);
  // CLI unchanged.
  assert.equal(runVerify(a.id, { cwd, evidence: 'checked', source: 'siim', channel: 'cli' }).verified_with, 'operator');
});

test('MCP verify: a plain verify of an operator record is refused (re-witness); needs_review still reported', async () => {
  const cwd = await project();
  const op = runRemember('fact', OTHER.title, { cwd, body: OTHER.body, source: 'human:op' });
  const before = rec(cwd, op.id);
  assert.throws(() => runVerify(op.id, { cwd, evidence: 'checked', checkBy: 'never', channel: 'mcp' }), NOT_OVER_MCP);
  const after = rec(cwd, op.id);
  assert.equal(after.last_verified, before.last_verified);
  assert.equal(after.check_by, before.check_by);
  assert.equal(after.verified_with, 'operator');
});

async function anchoredOperator(): Promise<{ cwd: string; id: string; file: string; sha: string }> {
  const cwd = await project();
  mkdirSync(join(cwd, 'src'));
  const file = join(cwd, 'src', 'limits.ts');
  writeFileSync(file, 'export const MAX_UPLOAD_MB = 5;\n');
  const r = runRemember('fact', 'Uploads are capped at 5 MB', { cwd, body: 'MAX_UPLOAD_MB', source: 'human:op', anchors: ['src/limits.ts'] });
  return { cwd, id: r.id, file, sha: r.anchors[0].sha };
}

test('MCP anchor: anchoring an operator record is refused (merge and replace forms); CLI allowed', async () => {
  const { cwd, id, file, sha } = await anchoredOperator();
  writeFileSync(file, '// changed\nexport const MAX_UPLOAD_MB = 50;\n');
  writeFileSync(join(cwd, 'src', 'other.ts'), 'export {};\n');
  const before = rec(cwd, id);
  assert.throws(() => runAnchor(id, ['src/limits.ts'], { cwd, channel: 'mcp' }), NOT_OVER_MCP);
  assert.throws(() => runAnchor(id, ['src/other.ts'], { cwd, replace: true, channel: 'mcp' }), NOT_OVER_MCP);
  const after = rec(cwd, id);
  assert.equal(after.anchors![0].sha, sha);
  assert.equal(after.anchors!.length, 1);
  assert.equal(after.last_verified, before.last_verified);
  // Agent records still anchor over MCP; the CLI still anchors operator records.
  const agent = runRemember('fact', 'Other module exports nothing', { cwd, body: 'empty module', source: 'agent-a' });
  runAnchor(agent.id, ['src/other.ts'], { cwd, channel: 'mcp' });
  runAnchor(id, ['src/limits.ts'], { cwd, channel: 'cli' });
  assert.notEqual(rec(cwd, id).anchors![0].sha, sha);
});

test('MCP reconcile repair_renames apply: an operator record is listed, never re-pointed', async () => {
  const cwd = await project();
  const sub = join(cwd, 'sub');
  mkdirSync(sub);
  const git = (args: string[]) => execFileAsync('git', args, {
    cwd: sub,
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
  await git(['init', '--quiet']);
  writeFileSync(join(sub, 'old.py'), 'identical bytes\n');
  writeFileSync(join(sub, 'agent.py'), 'agent bytes\n');
  await git(['add', '.']);
  await git(['commit', '--quiet', '-m', 'initial']);
  const op = runRemember('fact', 'Movable operator module', { cwd, body: 'operator', source: 'human:op', anchors: ['sub/old.py'] });
  const ag = runRemember('fact', 'Movable agent module', { cwd, body: 'agent', source: 'agent-a', anchors: ['sub/agent.py'] });
  renameSync(join(sub, 'old.py'), join(sub, 'new.py'));
  renameSync(join(sub, 'agent.py'), join(sub, 'agent2.py'));
  await git(['add', '-A']);
  await git(['commit', '--quiet', '-m', 'rename']);

  const res = runReconcile({ cwd, repairRenames: true, apply: true, channel: 'mcp' });
  const opRepair = res.repairs.find((r) => r.memory_id === op.id)!;
  const agRepair = res.repairs.find((r) => r.memory_id === ag.id)!;
  assert.equal(opRepair.applied, false);
  assert.match(opRepair.skipped ?? '', /operator-sourced/);
  assert.equal(agRepair.applied, true);
  assert.equal(rec(cwd, op.id).anchors![0].file, 'sub/old.py');
  assert.equal(rec(cwd, ag.id).anchors![0].file, 'sub/agent2.py');
});

test('MCP relate: an edge INTO an operator record is refused; an edge pointing at one is fine', async () => {
  const cwd = await project();
  const op = runRemember('fact', 'Billing runs on the first of the month', { cwd, body: 'operator note', source: 'human:op' });
  const ag = runRemember('fact', 'Invoices are emailed after billing', { cwd, body: 'agent note', source: 'agent-a' });
  assert.throws(() => runRelate({ cwd, from: op.id, to: ag.id, type: 'supports', channel: 'mcp' }), NOT_OVER_MCP);
  assert.equal(rec(cwd, op.id).supports, undefined);
  runRelate({ cwd, from: ag.id, to: op.id, type: 'depends_on', channel: 'mcp' });
  runRelate({ cwd, from: op.id, to: ag.id, type: 'supports', channel: 'cli' });
  // unrelate's audit trail records a downgraded source over MCP.
  runUnrelate({ cwd, from: ag.id, to: op.id, type: 'depends_on', reason: 'wrong', source: 'siim', channel: 'mcp' });
  const removals = rec(cwd, ag.id).ext?.edge_removals as Array<{ removed_by: string }>;
  assert.equal(removals[0].removed_by, 'mcp:siim');
});

test('MCP question: operator questions are read-only, an operator source creates at agent tier', async () => {
  const cwd = await project();
  const a = runRemember('fact', 'Primary region is eu-north-1', { cwd, body: 'region a', source: 'agent-a' });
  const b = runRemember('decision', 'Failover region is eu-west-1', { cwd, body: 'region b', source: 'agent-a' });
  const opQ = runQuestion('Which region is primary?', { cwd, answers: [a.id], source: 'human:op', channel: 'cli' });
  assert.equal(effectiveSourceKind(rec(cwd, opQ.id)), 'operator');
  assert.throws(() => runQuestion(opQ.id, { cwd, add: [b.id], channel: 'mcp' }), NOT_OVER_MCP);
  assert.throws(() => runQuestion(opQ.id, { cwd, close: true, channel: 'mcp' }), NOT_OVER_MCP);
  assert.throws(() => runQuestion(opQ.id, { cwd, resolve: true, channel: 'mcp' }), NOT_OVER_MCP);
  assert.deepEqual(rec(cwd, opQ.id).answers, [a.id]);
  assert.throws(
    () => runRemember('fact', 'Primary region moved to eu-central-1', { cwd, body: 'moved', source: 'agent-a', answersQuestion: opQ.id, channel: 'mcp' }),
    NOT_OVER_MCP,
  );
  assert.equal(new MemspecStore(cwd).loadActive().filter((i) => i.title.includes('eu-central-1')).length, 0, 'claim not written');

  const agQ = runQuestion('Which region fails over?', { cwd, answers: [b.id], source: 'user', channel: 'mcp' });
  const q = rec(cwd, agQ.id);
  assert.equal(q.source, 'mcp:user');
  assert.equal(effectiveSourceKind(q), 'agent');
  assert.equal(q.ext?.claimed_source, 'user');
  runQuestion(agQ.id, { cwd, add: [a.id], channel: 'mcp' });
});

test('CLI supersede: merging into an operator survivor requires --override-operator (logged)', async () => {
  const cwd = await project();
  const op = runRemember('fact', 'Billing runs on the first of the month', { cwd, body: 'operator note', source: 'human:op' });
  const ag = runRemember('fact', 'Queue consumers ack after the write commits', { cwd, body: 'agent note', source: 'agent-a' });
  assert.throws(
    () => runSupersede(op.id, { cwd, reason: 'fold', mergeFrom: [ag.id], channel: 'cli', source: 'agent-a' }),
    /operator-sourced .*requires override_operator/,
  );
  assert.equal(rec(cwd, ag.id).state, 'active');
  assert.equal(rec(cwd, op.id).supersedes, undefined);
  runSupersede(op.id, { cwd, reason: 'fold', mergeFrom: [ag.id], overrideOperator: true, channel: 'cli', source: 'siim' });
  assert.match(rec(cwd, op.id).supersede_reason ?? '', /\[override_operator used on operator-sourced record\]/);
});

test('memspec MCP tools: anchor, relate, question and remember wiring carry the channel', async () => {
  const { cwd, id: opId } = await anchoredOperator();
  const ag = runRemember('fact', 'Invoices are emailed after billing', { cwd, body: 'agent note', source: 'agent-a' });
  const session = new McpSession([join(REPO_ROOT, 'src/mcp.ts'), '--cwd', cwd]);
  try {
    await session.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'memspec-test', version: '0.0.0' } });
    session.notify('notifications/initialized', {});
    const call = async (name: string, args: Record<string, unknown>) =>
      (await session.request('tools/call', { name, arguments: args })).result as { isError?: boolean; content: Array<{ text: string }>; structuredContent?: Record<string, unknown> };

    const anchor = await call('memspec_anchor', { id: opId, files: ['src/limits.ts'], replace: true });
    assert.equal(anchor.isError, true);
    assert.match(anchor.content[0].text, NOT_OVER_MCP);

    const relate = await call('memspec_relate', { from: opId, to: ag.id, type: 'supports' });
    assert.equal(relate.isError, true);
    assert.match(relate.content[0].text, NOT_OVER_MCP);

    const remember = await call('memspec_remember', { type: 'fact', title: 'Release freeze starts on the 20th', body: 'stated by siim for the release freeze window', source: 'siim' });
    assert.notEqual(remember.isError, true, remember.content[0].text);
    assert.equal(remember.structuredContent?.source, 'mcp:siim');
    assert.match(String(remember.structuredContent?.source_warning), /names an operator/);
    const written = rec(cwd, String(remember.structuredContent?.id));
    assert.equal(effectiveSourceKind(written), 'agent');
  } finally {
    await session.close();
  }
});

// --- Tombstone ---------------------------------------------------------------

async function rejected(): Promise<{ cwd: string; oldId: string; survivorId: string }> {
  const cwd = await project();
  const old = runRemember('fact', OLD.title, { cwd, body: OLD.body, source: 'agent-a' });
  const survivorId = runSupersede(old.id, { cwd, reason: 'lowered to 15', title: NEW.title, body: NEW.body, source: 'agent-a' }).survivor_id;
  return { cwd, oldId: old.id, survivorId };
}

test('tombstone fails closed: a broken search index does not skip it', async () => {
  const { cwd, oldId } = await rejected();
  // A directory where the FTS cache file belongs: store.search throws.
  const fts = join(cwd, '.memspec', '.fts.db');
  if (existsSync(fts)) renameSync(fts, `${fts}.bak`);
  mkdirSync(fts);
  assert.throws(() => new MemspecStore(cwd).search('session cache', {}), 'fixture: search is broken');
  assert.throws(
    () => runRemember('fact', OLD.title, { cwd, body: OLD.body, source: 'agent-b', channel: 'mcp' }),
    new RegExp(`remember refuses rejected value: this value was rejected in ${oldId}`),
  );
  // The near-duplicate band too.
  assert.throws(
    () => runRemember('fact', 'Session cache entries live in Redis', { cwd, body: 'TTL is 15 minutes; session cache entries expire after 15 minutes.', source: 'agent-b', channel: 'mcp' }),
    /remember refuses (near-duplicate|rejected value)/,
  );
});

test('tombstone: a declared edge to the survivor does not launder a claim mixing old and new values', async () => {
  const mixed = { title: OLD.title, body: 'Session cache entries expire after 30 minutes, not 15 minutes.' };
  assert.ok(claimSimilarity(mixed, OLD) >= CLAIM_SIMILARITY_THRESHOLD);
  assert.ok(claimSimilarity(mixed, NEW) >= CLAIM_SIMILARITY_THRESHOLD);
  assert.ok(claimSimilarity(mixed, NEW) <= claimSimilarity(mixed, OLD));
  assert.ok(claimSimilarity(OLD, NEW) < CLAIM_SIMILARITY_THRESHOLD, 'the supersede changed the value');
  const { cwd, oldId, survivorId } = await rejected();
  for (const edge of ['distinctFrom', 'refines'] as const) {
    assert.throws(
      () => runRemember('fact', mixed.title, { cwd, body: mixed.body, source: 'agent-b', channel: 'mcp', [edge]: [survivorId] }),
      new RegExp(`remember refuses rejected value: this value was rejected in ${oldId}`),
    );
  }
  // A refinement that is closer to the survivor than to the rejected record is still written.
  const child = runRemember('fact', 'Session cache TTL is 15 minutes in production', {
    cwd, body: 'Production session cache entries expire after 15 minutes.', source: 'agent-b', channel: 'mcp', refines: [survivorId],
  });
  assert.ok(rec(cwd, child.id));
});

test('tombstone: re-scoping (any scope) or re-typing does not bring a rejected value back', async () => {
  const cwd = await makeTempProject();
  await runCli(['init', '--cwd', cwd]);
  const config = join(cwd, '.memspec', 'config.yaml');
  writeFileSync(config, `${readFileSync(config, 'utf8')}\nscopes:\n  kvart: ['${join(cwd, 'kvart')}/**']\n  other: ['${join(cwd, 'other')}/**']\n`);
  const old = runRemember('fact', OLD.title, { cwd, body: OLD.body, source: 'agent-a', scope: 'kvart' });
  runSupersede(old.id, { cwd, reason: 'lowered', title: NEW.title, body: NEW.body, source: 'agent-a' });
  const refused = new RegExp(`remember refuses rejected value: this value was rejected in ${old.id}`);
  assert.throws(() => runRemember('fact', OLD.title, { cwd, body: OLD.body, source: 'agent-b', scope: 'universal', channel: 'mcp' }), refused);
  assert.throws(() => runRemember('decision', OLD.title, { cwd, body: OLD.body, source: 'agent-b', scope: 'kvart', channel: 'mcp' }), refused);
  // An archived rejection is a rejection everywhere: another project's scope too.
  assert.throws(() => runRemember('fact', OLD.title, { cwd, body: OLD.body, source: 'agent-b', scope: 'other', channel: 'mcp' }), refused);
});

test('tombstone: a replacement body with merge_from replaces the target and merges the rest (twins stay refused over MCP)', async () => {
  const cwd = await project();
  const a = runRemember('fact', OLD.title, { cwd, body: OLD.body, source: 'agent-a' });
  const b = runRemember('fact', 'Sessions in the cache live 30 minutes', { cwd, body: 'Cached sessions are dropped after 30 minutes.', source: 'agent-a', distinctFrom: [a.id] });
  const s = runSupersede(a.id, { cwd, reason: 'lowered', title: NEW.title, body: NEW.body, mergeFrom: [b.id], source: 'agent-a' }).survivor_id;
  assert.equal(rec(cwd, a.id).ext?.supersede_kind, 'replace');
  assert.equal(rec(cwd, b.id).ext?.supersede_kind, 'merge');
  assert.throws(
    () => runRemember('fact', OLD.title, { cwd, body: OLD.body, source: 'agent-b', channel: 'mcp', distinctFrom: [s] }),
    new RegExp(`remember refuses rejected value: this value was rejected in ${a.id}`),
  );
  // The merged twin restated over MCP: the near-duplicate refusal naming the
  // survivor, final (a declared edge does not exempt it), never written.
  for (const options of [{}, { distinctFrom: [s] }]) {
    assert.throws(
      () => runRemember('fact', 'Sessions in the cache live 30 minutes', { cwd, body: 'Cached sessions are dropped after 30 minutes.', source: 'agent-b', channel: 'mcp', ...options }),
      (err: Error) => err.message.startsWith('remember refuses near-duplicate:') && err.message.includes(`merged into the active fact ${s}`) && /final/.test(err.message),
    );
  }
  assert.equal(new MemspecStore(cwd).loadActive().length, 1);
});

test('tombstone: a piece merged into S, then S replaced by T, is a rejected value (not held by T)', async () => {
  const cwd = await project();
  const s = runRemember('fact', OTHER.title, { cwd, body: OTHER.body, source: 'agent-a' });
  const a = runRemember('fact', OLD.title, { cwd, body: OLD.body, source: 'agent-a' });
  runSupersede(s.id, { cwd, reason: 'fold the TTL into the cache fact', mergeFrom: [a.id], source: 'agent-a', channel: 'mcp' });
  assert.equal(rec(cwd, a.id).ext?.supersede_kind, 'merge');
  const t = runSupersede(s.id, {
    cwd, reason: 'cache moved', title: 'Session cache is in-process', body: 'Session state lives in process memory; no shared cache tier remains.', source: 'agent-a', channel: 'mcp',
  }).survivor_id;
  for (const options of [{}, { distinctFrom: [t] }]) {
    assert.throws(
      () => runRemember('fact', OLD.title, { cwd, body: OLD.body, source: 'agent-b', channel: 'mcp', ...options }),
      new RegExp(`remember refuses rejected value: this value was rejected in ${a.id}`),
    );
  }
});

// --- Serialized check-then-write -------------------------------------------

test('withFileLock: busy while held, reclaimed when stale, released after success and failure', async () => {
  const cwd = await project();
  const root = join(cwd, '.memspec');
  const lock = join(root, 'local', 'locks', 'k.lock');
  assert.equal(withFileLock(root, 'k', () => 1), 1);
  assert.equal(existsSync(lock), false, 'released');
  assert.throws(() => withFileLock(root, 'k', () => { throw new Error('boom'); }), /boom/);
  assert.equal(existsSync(lock), false, 'released after a throw');

  writeFileSync(lock, '1\n');
  const t0 = Date.now();
  assert.throws(() => withFileLock(root, 'k', () => 1, { waitMs: 120 }), /another memspec write holds/);
  assert.ok(Date.now() - t0 >= 100, 'waited before giving up');
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  assert.equal(withFileLock(root, 'k', () => 2, { waitMs: 50 }), 2, 'stale lock reclaimed');
});

test('remember and verify take their locks (held lock refuses after the wait)', async () => {
  const cwd = await project();
  const a = runRemember('fact', OTHER.title, { cwd, body: OTHER.body, source: 'agent-a' });
  const locks = join(cwd, '.memspec', 'local', 'locks');
  mkdirSync(locks, { recursive: true });
  await withLockWait(50, () => {
    writeFileSync(join(locks, 'remember.lock'), '1\n');
    assert.throws(() => runRemember('fact', NEW.title, { cwd, body: NEW.body, source: 'agent-a' }), /another memspec write holds/);
    writeFileSync(join(locks, `record-${a.id}.lock`), '1\n');
    assert.throws(() => runVerify(a.id, { cwd, evidence: 'checked' }), /another memspec write holds/);
    assert.throws(() => runAnchor(a.id, ['x'], { cwd }), /another memspec write holds/);
  });
  assert.equal(new MemspecStore(cwd).loadActive().length, 1);
});

test('two concurrent CLI remembers of one claim: exactly one is written', async () => {
  const cwd = await project();
  const results = await Promise.allSettled([
    runCli(['remember', 'fact', 'Gateway uses mTLS for upstream authentication', '--cwd', cwd, '--body', 'Every upstream call from the gateway presents a client certificate.', '--source', 'agent-a']),
    runCli(['remember', 'fact', 'The gateway authenticates upstream calls with mTLS', '--cwd', cwd, '--body', 'Every upstream call from the gateway presents a client certificate (mTLS).', '--source', 'agent-b']),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, JSON.stringify(results.map((r) => r.status)));
  assert.equal(new MemspecStore(cwd).loadActive().length, 1);
});
