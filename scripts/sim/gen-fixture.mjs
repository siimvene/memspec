#!/usr/bin/env node
// Deterministic generator for the memspec simulated-memory dev fixture.
// Authors a realistic corpus of a fictional company's ("Helix") accumulated
// project memory, plus a labeled query set, for internal retrieval testing.
//
// Design guards against a rigged "highlight reel":
//   - Queries are phrased in user language with a deliberate LEXICAL GAP from
//     the answer record (real users don't echo stored wording).
//   - Near-miss DISTRACTORS lexically match the query but are the wrong answer,
//     so a keyword-only ranker gets punished.
//   - Some patterns are expected to FAIL on current code (headroom), and that
//     is labeled, not hidden.
//
// Output is fully deterministic (fixed ids + timeline, no wall clock / ulid /
// rng surprises) so the committed fixture diffs cleanly.
//
//   node gen-fixture.mjs <out-root>   # writes <out-root>/.memspec + queries.json

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.SIM_REPO_ROOT || resolve(here, '..', '..');
const OUT_ROOT = process.argv[2] || join(here, 'fixture');

const { serializeMemoryFile } = await import(pathToFileURL(join(REPO_ROOT, 'dist/lib/frontmatter.js')).href);
const { MemspecStore } = await import(pathToFileURL(join(REPO_ROOT, 'dist/lib/store.js')).href);

// --- deterministic timeline -------------------------------------------------
const BASE = Date.parse('2025-01-01T00:00:00Z');
const DAY = 86400000;
const at = (day) => new Date(BASE + day * DAY).toISOString().replace('.000Z', 'Z');

// --- id assignment (ms_ + 26 chars, [A-Z0-9]) -------------------------------
let counter = 0;
const nextId = () => `ms_${String(++counter).padStart(26, '0')}`;

// --- record authoring -------------------------------------------------------
const records = []; // {dir, item}
const ids = {};     // handle -> id

// mk(handle, {type, title, body, day, ...}) → returns id
function mk(handle, o) {
  const id = nextId();
  ids[handle] = id;
  const created = at(o.day);
  const item = {
    id,
    kind: o.kind || 'claim',
    ...(o.kind === 'observation' ? {} : { type: o.type }),
    state: o.state || 'active',
    created,
    source: 'sim',
    source_kind: 'agent',
    tags: o.tags || [],
    check_by: o.check_by || 'never',
    last_verified: o.last_verified || created,
    verified_with: o.verified_with || 'assertion',
    title: o.title,
    body: o.body,
  };
  for (const k of ['refines', 'supports', 'depends_on', 'conflicts_with', 'supersedes', 'superseded_by', 'supersede_reason', 'valid_from', 'valid_to', 'expires', 'pinned']) {
    if (o[k] !== undefined) item[k] = o[k];
  }
  const dir = o.state === 'superseded' || o.state === 'retired' ? 'archive'
    : o.kind === 'observation' ? 'observations'
    : `memory/${o.type}s`;
  records.push({ dir, item });
  return id;
}

const queries = [];
const q = (o) => queries.push(o);

// ===========================================================================
// CORE records — carry ground truth. Query targets, their edges, temporal
// versions, supersede chains, near-miss distractors, conflicts.
// ===========================================================================

// --- edge-walk: answer lives in a depends_on neighbour ---------------------
// Target names Postgres but never says "billing". Seed says "billing/invoices"
// but never names the DB (says "system of record"). Only the edge connects them.
mk('datastore', { type: 'decision', day: 20,
  title: 'Primary datastore selection',
  body: 'PostgreSQL 16 was chosen as the platform system of record. It gives us strong ACID guarantees, logical replication for read replicas, and mature backup tooling. All durable business state lands here.' });
mk('billing', { type: 'fact', day: 60,
  title: 'Billing service responsibilities',
  body: 'The billing service computes invoices, applies discounts, and reconciles payments against ledger entries. It persists every financial record to the platform system of record rather than keeping its own store.',
  depends_on: [ids.datastore] });
// near-miss distractor: matches "invoice" strongly, but is the wrong answer to
// "which database stores invoices".
mk('invoice_pdf', { type: 'procedure', day: 70,
  title: 'Invoice PDF generation',
  body: 'Invoices are rendered to PDF by a headless Chromium instance in the reporting worker, then uploaded to object storage and linked from the customer portal.' });

q({ pattern: 'edge-walk', metric: 'recall@5',
  query: 'which database does the billing service keep invoices in',
  targets: [ids.datastore], distractors: [ids.billing, ids.invoice_pdf],
  opts: { expandEdges: true, expandDepth: 1 },
  rationale: 'answer record never says "billing"; billing record never names the DB — only the depends_on edge bridges them' });

// --- temporal: as_of must select the era valid at a timestamp --------------
mk('host_v1', { type: 'decision', day: 5,
  title: 'Production hosting — colocation era',
  body: 'Production runs on bare-metal servers colocated in a Tallinn data centre, provisioned with Ansible and fronted by HAProxy.',
  valid_from: at(0), valid_to: at(180) });
mk('host_v2', { type: 'decision', day: 185,
  title: 'Production hosting — managed cloud era',
  body: 'Production runs on AWS in eu-north-1 on ECS Fargate behind an application load balancer, with RDS for the datastore.',
  valid_from: at(181), valid_to: at(364) });
mk('host_v3', { type: 'decision', day: 370,
  title: 'Production hosting — sovereign cloud era',
  body: 'Production runs on Hetzner Cloud with a k3s cluster, managed by Terraform and reconciled with Flux GitOps.',
  valid_from: at(365) });

for (const [asOf, tgt, label] of [[at(60), 'host_v1', 'colo'], [at(260), 'host_v2', 'cloud'], [at(400), 'host_v3', 'sovereign']]) {
  q({ pattern: 'temporal', metric: 'top1-correct',
    query: 'where is production hosted', as_of: asOf,
    targets: [ids[tgt]], distractors: [ids.host_v1, ids.host_v2, ids.host_v3].filter((x) => x !== ids[tgt]),
    opts: { asOf },
    rationale: `three eras exist; only the ${label} era is valid at ${asOf.slice(0, 10)}` });
}

// --- archive-chain: the rationale we need is in a superseded predecessor ----
mk('auth_old', { type: 'decision', day: 40, state: 'superseded',
  title: 'API authentication — static keys',
  body: 'We originally authenticated API clients with long-lived static keys sent in an X-API-Key header. Chosen for launch speed; the tradeoff was no rotation and no per-scope permissions.',
  superseded_by: undefined /* set below */ });
mk('auth_new', { type: 'decision', day: 300,
  title: 'API authentication — OAuth2 tokens',
  body: 'API authentication now uses short-lived OAuth2 bearer tokens issued by the identity service, with per-scope grants and automatic rotation.',
  supersedes: [ids.auth_old], supersede_reason: 'Static keys could not be rotated or scoped; security review flagged them.' });
// fix the back-link now that auth_new has an id
records.find((r) => r.item.id === ids.auth_old).item.superseded_by = ids.auth_new;

q({ pattern: 'archive-chain', metric: 'recall@5',
  query: 'why did we stop using long-lived api keys',
  targets: [ids.auth_old], distractors: [ids.auth_new],
  opts: { expandEdges: true, includeSuperseded: true, expandDepth: 1 },
  rationale: 'the rationale lives in the superseded record; the active record does not mention static keys' });

// --- precision / near-miss: a lexical twin must not beat the real answer ----
mk('cache', { type: 'fact', day: 90,
  title: 'Cache eviction policy',
  body: 'Redis is configured with the allkeys-lru maxmemory-policy. When the instance approaches its memory limit, the least-recently-used keys are evicted first.',
  check_by: at(120) /* in the past relative to latest records → stale */ });
mk('oom', { type: 'fact', day: 95,
  title: 'Worker out-of-memory handling',
  body: 'When a worker process runs low on available memory the Linux OOM killer may terminate it; systemd restarts the unit and the job is retried from the queue.' });

// direct control (should pass): near-exact wording
q({ pattern: 'direct', metric: 'recall@5',
  query: 'redis cache eviction policy',
  targets: [ids.cache], distractors: [ids.oom],
  opts: {},
  rationale: 'sanity control — wording overlaps the target; should rank 1' });

// precision: user phrasing collides with the OOM distractor
q({ pattern: 'precision', metric: 'top1-correct',
  query: 'what gets dropped from the cache when memory runs low',
  targets: [ids.cache], distractors: [ids.oom],
  opts: {},
  rationale: '"runs low on memory" lexically matches the OOM record; correct answer is the cache-eviction record' });

// paraphrase-hard (headroom, likely FAILS on BM25): heavy lexical gap, no edge
q({ pattern: 'paraphrase-hard', metric: 'recall@5',
  query: 'how does the system decide which entries to discard under memory pressure',
  targets: [ids.cache], distractors: [ids.oom],
  opts: {},
  rationale: 'no rare term overlap with the answer (allkeys-lru); expected headroom for a semantic backend' });

// --- multi-answer cluster: several records jointly answer -------------------
mk('obs_metrics', { type: 'fact', day: 110, title: 'Metrics pipeline',
  body: 'Application metrics are scraped by Prometheus and visualised in Grafana dashboards owned by each service team.' });
mk('obs_logs', { type: 'fact', day: 112, title: 'Log aggregation',
  body: 'Structured logs ship to Loki via promtail; retention is 30 days and queries run through the Grafana explore view.' });
mk('obs_traces', { type: 'fact', day: 114, title: 'Distributed tracing',
  body: 'Services emit OpenTelemetry spans to Tempo, letting us follow a request across the billing, identity, and reporting services.' });

q({ pattern: 'multi-answer', metric: 'multi-recall@10',
  query: 'how do we observe what production is doing',
  targets: [ids.obs_metrics, ids.obs_logs, ids.obs_traces], distractors: [],
  opts: {},
  rationale: 'observability spans three records; measures completeness, not single best hit' });

// --- conflict: two active records disagree ---------------------------------
mk('flags_a', { type: 'decision', day: 130, title: 'Feature flags — vendor',
  body: 'Feature flags are managed in LaunchDarkly so product managers can toggle rollouts without a deploy.',
  conflicts_with: [] /* set below */ });
mk('flags_b', { type: 'decision', day: 210, title: 'Feature flags — in-house',
  body: 'Feature flags are served from an in-house service backed by the datastore, to avoid a third-party dependency on the request path.',
  conflicts_with: [ids.flags_a] });
records.find((r) => r.item.id === ids.flags_a).item.conflicts_with = [ids.flags_b];

q({ pattern: 'conflict', metric: 'multi-recall@10',
  query: 'what do we use for feature flags',
  targets: [ids.flags_a, ids.flags_b], distractors: [],
  opts: {},
  rationale: 'two unresolved conflicting decisions both exist; both should be retrievable' });

// ===========================================================================
// BACKGROUND records — realistic unrelated memory, never query targets. Pure
// BM25 competition. No ground truth attached, so no circularity. Deliberately
// off-topic from every labeled query so no unlabeled correct answer is created.
// Deterministically generated: aspect templates × subsystems, seeded subset.
// ===========================================================================
function mulberry32(seed) {
  let t = seed >>> 0;
  return () => { t = (t + 0x6D2B79F5) >>> 0; let r = t; r = Math.imul(r ^ (r >>> 15), r | 1); r ^= r + Math.imul(r ^ (r >>> 7), r | 61); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; };
}
const rng = mulberry32(1);
const pick = (arr) => arr[Math.floor(rng() * arr.length)];
const pint = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

const SUBSYSTEMS = [
  'ingestion pipeline', 'search indexer', 'notification service', 'reporting worker',
  'identity service', 'audit log writer', 'data warehouse loader', 'webhook dispatcher',
  'schema registry', 'feature store', 'export service', 'image resizer', 'email gateway',
  'sms gateway', 'payment reconciler', 'fraud scorer', 'recommendation engine',
  'session store', 'config service', 'job scheduler', 'backup agent', 'log shipper',
  'api gateway', 'tenant provisioner',
];
const TEAMS = ['platform', 'data', 'growth', 'payments', 'infra', 'core'];
const STORES = ['Postgres', 'S3', 'the data warehouse', 'a local RocksDB', 'MinIO'];
// aspect templates read naturally and differently, to avoid formulaic slop.
const ASPECTS = [
  { t: 'retry policy', type: 'fact', f: (s) => `The ${s} retries transient failures with exponential backoff, giving up after ${pint(3, 8)} attempts and routing the payload to a dead-letter queue.` },
  { t: 'request timeout', type: 'fact', f: (s) => `Calls into the ${s} use a ${pint(2, 30)}-second timeout; a tripped circuit breaker sheds load rather than blocking callers.` },
  { t: 'scaling', type: 'decision', f: (s) => `The ${s} scales horizontally behind a work queue; ${pint(2, 12)} replicas run in steady state and autoscale on queue lag.` },
  { t: 'ownership', type: 'fact', f: (s) => `The ${s} is owned by the ${pick(TEAMS)} team, who run its on-call rotation and capacity planning.` },
  { t: 'cold storage', type: 'decision', f: (s) => `The ${s} keeps its working set in ${pick(STORES)}, aging cold data out after ${pint(30, 365)} days.` },
  { t: 'schema versioning', type: 'procedure', f: (s) => `Message schemas for the ${s} are versioned in the registry; producers must remain backward compatible across a deploy.` },
  { t: 'deploy', type: 'procedure', f: (s) => `The ${s} deploys on merge to main through the standard pipeline, with a canary step before full rollout.` },
  { t: 'idempotency', type: 'fact', f: (s) => `The ${s} deduplicates work by idempotency key so redelivered messages are not double-processed.` },
  { t: 'quotas', type: 'decision', f: (s) => `The ${s} enforces a per-tenant quota of ${pint(50, 5000)} requests per minute, returning 429 with a retry-after header.` },
  { t: 'availability target', type: 'fact', f: (s) => `The ${s} targets ${pint(2, 4)} nines of monthly availability; sustained breaches page the owning team.` },
];
let bgDay = 150;
for (const s of SUBSYSTEMS) {
  const n = pint(6, 9);
  const chosen = ASPECTS.slice().sort(() => rng() - 0.5).slice(0, n);
  for (const a of chosen) {
    mk(`bg_${counter}`, { type: a.type, day: (bgDay += 1) % 500, title: `${s[0].toUpperCase()}${s.slice(1)} — ${a.t}`, body: a.f(s) });
  }
}

// --- write ------------------------------------------------------------------
rmSync(OUT_ROOT, { recursive: true, force: true });
mkdirSync(OUT_ROOT, { recursive: true });
new MemspecStore(OUT_ROOT).init();
const memRoot = join(OUT_ROOT, '.memspec');
for (const { dir, item } of records) {
  const path = join(memRoot, dir, `${item.id}.md`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeMemoryFile(item));
}
writeFileSync(join(here, 'queries.json'), JSON.stringify({ base: at(0), queries }, null, 2));

// --- self-validate: every record must parse cleanly -------------------------
const loaded = new MemspecStore(OUT_ROOT).loadAll();
if (loaded.length !== records.length) {
  throw new Error(`validation failed: authored ${records.length} records but loadAll() returned ${loaded.length}`);
}
console.log(`[gen] wrote ${records.length} records (${records.filter((r) => r.dir === 'archive').length} archived) + ${queries.length} queries → ${OUT_ROOT}`);
console.log(`[gen] loadAll() parsed ${loaded.length}/${records.length} cleanly`);
