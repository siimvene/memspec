import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { claimIdentifiers, claimShape, claimSimilarity, claimTokens, CLAIM_SIMILARITY_THRESHOLD, newIdentifiers, sameClaim } from '../src/lib/similarity.js';
import { makeTempProject, REPO_ROOT, runCli } from './helpers.js';
import { McpSession } from './mcp-session.js';

/**
 * Review round on the near-duplicate identifier rule: each test is a pair the
 * rule judged wrong before the fix (a restatement written as a new record, or
 * a coincidence read as a mention), plus the guard against the other failure
 * direction where one exists.
 */

type Claim = { title: string; body: string };
const shape = (c: Claim) => claimShape(c.title, c.body);
const same = (a: Claim, b: Claim) => {
  assert.ok(claimSimilarity(a, b) >= CLAIM_SIMILARITY_THRESHOLD, `${a.title} vs ${b.title}: ${claimSimilarity(a, b).toFixed(2)}`);
  return sameClaim(shape(a), shape(b)) && sameClaim(shape(b), shape(a));
};

test('provenance: an ISO timestamp with a numeric UTC offset is provenance, like one in Z', () => {
  assert.deepEqual([...claimIdentifiers('Verified 2026-10-26T10:00:00+02:00', 'Also seen 2026-10-27T08:15:00.123-0530 and 2026-10-27T08:15:00+05.')], []);
  const body = 'The nightly export job writes the ledger snapshot to the archive bucket and verifies its checksum before rotating old snapshots.';
  assert.equal(same({ title: 'Ledger export verified 2026-10-26T10:00:00+02:00', body }, { title: 'Ledger export verified 2026-10-27T10:00:00+02:00', body }), true);
  // A bare clock time is still a value (a cron schedule), not provenance.
  assert.ok(claimIdentifiers('Backup runs at 02:00+02:00').size > 0);
});

const DB = 'The staging cluster database runs this version with nightly backups and two read replicas behind the pooler.';

test('a multi-word code span names the identifiers inside it: `Postgres 16.2` is Postgres 16.2', () => {
  assert.ok(claimIdentifiers('Staging runs `Postgres 16.2`').has('16.2'));
  assert.equal(same({ title: 'Staging runs `Postgres 16.2`', body: DB }, { title: 'Staging runs Postgres 16.2', body: DB }), true);
  assert.equal(
    same({ title: 'Hook stash slot `STASH_CALLBACK = 2` in the hooks module', body: DB }, { title: 'Hook stash slot STASH_CALLBACK = 2 in the hooks module', body: DB }),
    true,
  );
  assert.equal(same({ title: 'The rollout follows `Option B` this quarter', body: DB }, { title: 'The rollout follows Option B this quarter', body: DB }), true);
  // Another value inside the span is still another claim.
  assert.equal(same({ title: 'Staging runs `Postgres 16.3`', body: DB }, { title: 'Staging runs Postgres 16.2', body: DB }), false);
  assert.equal(
    same({ title: 'Hook stash slot `STASH_EFFECT = 2` in the hooks module', body: DB }, { title: 'Hook stash slot STASH_CALLBACK = 2 in the hooks module', body: DB }),
    false,
  );
});

const BACKUPS = 'Nightly backups are uploaded to the bucket with server side encryption and a thirty day lifecycle rule.';

test('a number-bearing word matches whatever its case: S3 is `S3 upload` and S3-bucket', () => {
  assert.equal(same({ title: 'Backups go to S3 upload nightly', body: BACKUPS }, { title: 'Backups go to `S3 upload` nightly', body: BACKUPS }), true);
  assert.equal(same({ title: 'Backups go to S3 nightly', body: BACKUPS }, { title: 'Backups go to S3-bucket nightly', body: BACKUPS }), true);
  assert.equal(same({ title: 'Release ships on v2 runners', body: BACKUPS }, { title: 'Release ships on `V2` runners', body: BACKUPS }), true);
  assert.equal(same({ title: 'Backups go to S3 nightly', body: BACKUPS }, { title: 'Backups go to R2 nightly', body: BACKUPS }), false);
});

const HOOK = 'The constant is read by the hook dispatcher when it stashes callbacks between renders of the component.';

test('a backticked single capital is a label: `B` is B, and a sentence-initial article is not `A`', () => {
  assert.ok(claimIdentifiers('Option `B` wins').has('#b'));
  assert.equal(same({ title: 'Option `B` is the chosen rollout', body: HOOK }, { title: 'Option B is the chosen rollout', body: HOOK }), true);
  assert.deepEqual(newIdentifiers(['#a'], shape({ title: 'A constant in src/a.ts is set to 2', body: HOOK })), ['A']);
  assert.equal(same({ title: '`A` in src/a.ts is set to 2', body: HOOK }, { title: 'A constant in src/a.ts is set to 2', body: HOOK }), false);
  assert.equal(same({ title: '`A` in src/a.ts is set to 2', body: HOOK }, { title: '`B` in src/a.ts is set to 2', body: HOOK }), false);
});

test('backticks around a plain word do not change the wording: `release branch` reads as release branch', () => {
  assert.equal(
    same(
      { title: 'Deploys run from the `release branch` only', body: 'CI deploys to production only from the `release branch`; `main` never deploys.' },
      { title: 'Deploys run from the release branch only', body: 'CI deploys to production only from the release branch; main never deploys.' },
    ),
    true,
  );
  assert.equal(same({ title: 'Backups are encrypted with `age` before upload to S3', body: '' }, { title: 'Backups are encrypted with age prior to S3 upload', body: '' }), true);
  // Different wording about the same backticked symbol is still a different claim.
  const sig = { title: '`getProcessor` in src/adapter/aws-lambda/handler.ts takes parameters (event)', body: '`getProcessor` in src/adapter/aws-lambda/handler.ts takes parameters (event). Full value: (event). Read from src/adapter/aws-lambda/handler.ts at hono 0123456789ab.' };
  const exp = { title: 'src/adapter/aws-lambda/handler.ts exports `getProcessor` as a runtime value', body: 'src/adapter/aws-lambda/handler.ts exports `getProcessor` as a runtime value. Full value: value. Read from src/adapter/aws-lambda/handler.ts at hono 0123456789ab.' };
  assert.equal(same(sig, exp), false);
});

test('ReDoS: a 200,000-character adversarial chunk is scanned in linear time', () => {
  const chunks = [
    `${'.'.repeat(200_000)}a`,
    `${').,;:!?*'.repeat(25_000)}a`,
    `${'…'.repeat(200_000)}a`,
    `.${')'.repeat(200_000)}a`,
    `${'.'.repeat(200_000)}"a`,
    `${'a-'.repeat(100_000)}!x`,
    `\`${'a'.repeat(200_000)}`,
    `2026-01-01t${'1:'.repeat(100_000)}q`,
  ];
  for (const chunk of chunks) {
    const t0 = performance.now();
    claimShape(chunk, chunk);
    claimTokens(chunk, chunk);
    const ms = performance.now() - t0;
    assert.ok(ms < 200, `${JSON.stringify(chunk.slice(0, 12))}... took ${ms.toFixed(0)} ms`);
  }
});

test('MCP: remember, supersede and observe refuse an oversized title or body with a clear error', async () => {
  const target = await makeTempProject();
  await runCli(['init', '--cwd', target]);
  const session = new McpSession([join(REPO_ROOT, 'src/mcp.ts'), '--cwd', target]);
  try {
    await session.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'memspec-test', version: '0.0.0' } });
    session.notify('notifications/initialized', {});
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await session.request('tools/call', { name, arguments: args });
      const result = res.result as { isError?: boolean; content?: Array<{ text: string }> } | undefined;
      return { error: res.error?.message ?? (result?.isError ? result.content?.map((c) => c.text).join('\n') : undefined) };
    };
    const ok = await call('memspec_remember', { type: 'fact', title: 'Size limit control', body: 'x'.repeat(20_000), scope: 'universal' });
    assert.equal(ok.error, undefined);
    for (const [name, args, field] of [
      ['memspec_remember', { type: 'fact', title: 't'.repeat(1_001), body: 'b' }, 'title'],
      ['memspec_remember', { type: 'fact', title: 'Oversized body', body: 'b'.repeat(20_001) }, 'body'],
      ['memspec_supersede', { id: 'ms_x', reason: 'r', title: 't'.repeat(1_001), body: 'b' }, 'title'],
      ['memspec_supersede', { id: 'ms_x', reason: 'r', body: 'b'.repeat(20_001) }, 'body'],
      ['memspec_observe', { text: 'o'.repeat(20_001) }, 'text'],
    ] as Array<[string, Record<string, unknown>, string]>) {
      const res = await call(name, args);
      assert.ok(res.error, `${name} ${field} accepted`);
      assert.match(res.error!, new RegExp(`${field}.*(at most|longer than)|(at most|longer than).*${field}`, 's'), `${name}: ${res.error}`);
    }
  } finally {
    await session.close();
  }
});
