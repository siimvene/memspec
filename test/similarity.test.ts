import test from 'node:test';
import assert from 'node:assert/strict';
import { CLAIM_SIMILARITY_THRESHOLD, claimSimilarity, claimTokens } from '../src/lib/similarity.js';

/**
 * Paired fixtures the near-duplicate / tombstone threshold was chosen from.
 * SAME: one claim restated (reordered, inflected, synonym-light). DIFFERENT:
 * same topic, different claim, including the value-change pair the tombstone
 * check must keep apart. The threshold sits between the two groups.
 */

type Claim = { title: string; body?: string };

const SAME_CLAIM_PAIRS: Array<[Claim, Claim]> = [
  [
    { title: 'Gateway uses mTLS for upstream authentication', body: 'Every upstream call from the gateway presents a client certificate.' },
    { title: 'The gateway authenticates to upstreams with mTLS', body: 'Upstream calls from the gateway present a client certificate (mutual TLS).' },
  ],
  [
    { title: 'Session cache TTL is 30 minutes', body: 'Session cache entries expire after 30 minutes.' },
    { title: 'Cached sessions expire after 30 minutes', body: 'The TTL for the session cache is 30 minutes.' },
  ],
  [
    { title: 'Deploys run from the release branch only', body: 'CI deploys to production only from the release branch; main never deploys.' },
    { title: 'Production deploys only run from release branch', body: 'Main does not deploy. Only the release branch deploys to production in CI.' },
  ],
  [
    { title: 'Postgres primary listens on port 5433', body: 'The primary database is on 5433, not the default 5432.' },
    { title: 'Primary Postgres port is 5433', body: 'Database primary listens on 5433 instead of default 5432.' },
  ],
  [
    { title: 'Backups are encrypted with age before upload to S3' },
    { title: 'Backups encrypted using age prior to S3 upload' },
  ],
  [
    { title: 'Frontend deploys on Cloudflare Pages', body: 'The web frontend is built and published by Cloudflare Pages on every merge to main.' },
    { title: 'The frontend is deployed via Cloudflare Pages', body: 'Every merge to main builds the web frontend and publishes it with Cloudflare Pages.' },
  ],
  [
    { title: 'Run alembic upgrade head before deploying', body: 'Migrations must be applied with alembic upgrade head before a deploy.' },
    { title: 'Apply migrations with alembic upgrade head prior to deploy', body: 'Before deploying, run alembic upgrade head to apply migrations.' },
  ],
  [
    { title: 'Nightly backup job runs at 02:00 UTC', body: 'The backup cron fires at 02:00 UTC and uploads to the backups bucket.' },
    { title: 'Backup cron schedule: 02:00 UTC nightly', body: 'Nightly at 02:00 UTC the backup cron runs and uploads to the backups bucket.' },
  ],
];

const DIFFERENT_CLAIM_PAIRS: Array<[Claim, Claim]> = [
  // Value change: the pair the tombstone check exists for.
  [
    { title: 'Session cache TTL is 30 minutes', body: 'Session cache entries expire after 30 minutes.' },
    { title: 'Session cache TTL is 15 minutes', body: 'Session cache entries expire after 15 minutes.' },
  ],
  [
    { title: 'Session cache TTL is 30 minutes', body: 'Session cache entries expire after 30 minutes.' },
    { title: 'Session cache is backed by Redis', body: 'Session cache entries live in the shared Redis cluster.' },
  ],
  [
    { title: 'API service deploys to Cloud Run in europe-north1', body: 'The API container is deployed to Cloud Run.' },
    { title: 'Worker service deploys to GKE in europe-west4', body: 'The worker container runs on the GKE cluster.' },
  ],
  [
    { title: 'Postgres primary listens on port 5433', body: 'The primary database is on 5433, not the default 5432.' },
    { title: 'Postgres replica listens on port 5434', body: 'The read replica database is on 5434.' },
  ],
  [
    { title: 'memspec v0.4 shipped with typed relations', body: 'Relations, tiering, export.' },
    { title: 'memspec v0.5 shipped with graph traversal', body: 'Graph traversal, temporal validity, eval harness.' },
  ],
  [
    { title: 'Gateway uses mTLS for upstream authentication', body: 'Every upstream call from the gateway presents a client certificate.' },
    { title: 'Gateway uses API keys for upstream authentication', body: 'Every upstream call from the gateway sends a static API key header.' },
  ],
  // A single-letter label weighs as an identifier, so it separates short claims.
  [
    { title: 'Slice A ships the read path', body: 'Search and get only.' },
    { title: 'Slice B ships the write path', body: 'Remember and supersede.' },
  ],
];

test('paraphrases of one claim score at or above the threshold', () => {
  for (const [a, b] of SAME_CLAIM_PAIRS) {
    const score = claimSimilarity(a, b);
    assert.ok(score >= CLAIM_SIMILARITY_THRESHOLD, `${score.toFixed(3)} < threshold for "${a.title}" vs "${b.title}"`);
  }
});

test('same-topic different claims (including a value change) score below the threshold', () => {
  for (const [a, b] of DIFFERENT_CLAIM_PAIRS) {
    const score = claimSimilarity(a, b);
    assert.ok(score < CLAIM_SIMILARITY_THRESHOLD, `${score.toFixed(3)} >= threshold for "${a.title}" vs "${b.title}"`);
  }
});

test('known limit: one swapped qualifier in otherwise identical text reads as a near-duplicate', () => {
  // Lexically indistinguishable from a synonym paraphrase; remember's refusal
  // names distinct_from as the way to record that the two are independent.
  const pairs: Array<[Claim, Claim]> = [
    [
      { title: 'Staging runs Postgres 16', body: 'The staging database is Postgres 16.' },
      { title: 'Production runs Postgres 16', body: 'The production database is Postgres 16.' },
    ],
    [
      { title: 'Rollout option A keeps the old schema readable', body: 'Option A dual-writes for one release.' },
      { title: 'Rollout option B keeps the old schema readable', body: 'Option B dual-writes for one release.' },
    ],
  ];
  for (const [a, b] of pairs) assert.ok(claimSimilarity(a, b) >= CLAIM_SIMILARITY_THRESHOLD);
});

test('claims too thin to judge never near-match (exact-title refusal covers identical short titles)', () => {
  assert.equal(claimSimilarity({ title: 'Operator-stated fact', body: 'B' }, { title: 'Agent-stated fact', body: 'B' }), 0);
  assert.equal(claimSimilarity({ title: 'Cycle node A', body: 'Body' }, { title: 'Cycle node A', body: 'Body' }), 0);
});

test('tokens: stopwords dropped, inflections meet, numbers and capital labels kept', () => {
  const tokens = claimTokens('The gateway authenticates upstreams', 'Option B uses port 5433');
  assert.ok(!tokens.has('the'));
  assert.ok(tokens.has('gatewa'));
  assert.deepEqual(claimTokens('authentication').has('authen'), tokens.has('authen'));
  assert.ok(tokens.has('upstr') || tokens.has('upstre'));
  assert.ok(tokens.has('5433'));
  assert.ok(tokens.has('#b'));
});
