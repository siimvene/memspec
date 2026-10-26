import { resolve } from 'node:path';
import { CompositeStore, describeStaleLayer, type StaleLayer } from '../lib/composite-store.js';
import { getAgingDays, getProfile, loadConfig } from '../lib/config.js';
import { agingOf } from '../lib/decay.js';
import { queryTokenPresence } from '../lib/fts.js';
import { COVERAGE_STOPWORDS } from '../lib/stopwords.js';
import { EDGE_TYPES, expandGraph, isDerived, type EdgeType, type ExpansionHit } from '../lib/graph-walk.js';
import { sharedTagCount, titleTokenOverlap } from '../lib/inference.js';
import { assertKnownScope, isVisibleFromScope, resolveScopeForCwd } from '../lib/scope.js';
import { type SearchRelevanceMeta, type StoreSearchOptions } from '../lib/store.js';
import { type DriftEntry } from '../lib/drift.js';
import { MEMORY_TYPES, VERIFIED_WITH, type MemoryItem, type MemoryType, type RecordState, type VerifiedWith } from '../lib/types.js';
import { recordSurfacedHitsByLayer, type UsageSurface } from '../lib/usage.js';
import { computeUsageStats } from '../lib/usage-stats.js';

export type SearchExpandDepth = 1 | 2 | 3;

export interface SearchOptions {
  cwd?: string;
  type?: string;
  limit?: string;
  json?: boolean;
  profile?: string;
  full?: boolean;
  /**
   * v0.5 Phase 1: when true, BM25 seed hits are extended by walking typed
   * edges (refines/supports/depends_on/conflicts_with/supersedes/superseded_by)
   * outward from each seed. Default false — v0.4 behaviour is preserved.
   */
  expandEdges?: boolean;
  /**
   * Subset of edge types to traverse. Defaults to all six. Order is preserved
   * so callers can prioritise certain edges and get deterministic output.
   */
  edgeTypes?: readonly EdgeType[];
  /** Hop cap on the BFS walk. Defaults to 1; capped at 3. */
  expandDepth?: SearchExpandDepth;
  /**
   * v0.5 Phase 2 — ISO 8601 timestamp. When set, drop results whose
   * world-state validity window doesn't contain this point. Records with no
   * `valid_from`/`valid_to` bounds are treated as always valid and always
   * returned. Orthogonal to `check_by` staleness — past `check_by` only
   * means review is overdue, past `valid_to` means the fact no longer holds.
   */
  asOf?: string;
  /**
   * v0.6 Phase 1 — when true with `expandEdges`, the expansion walker is
   * given a wider record map (active + superseded) so it can resolve edge
   * targets that point into the archive. The SEED pool stays active-only:
   * letting superseded records seed lexical search would flood results with
   * stale matches, defeating the lifecycle. This option only affects which
   * records expansion can SURFACE; it never changes what initially matches
   * the query. Default false — v0.5 behaviour preserved.
   *
   * Motivation: real-store eval (`q13-supersede-markedroid`) — expansion
   * across the supersede DAG couldn't reach an archived predecessor because
   * search built its expansion map from active records only.
   */
  includeSuperseded?: boolean;
  /**
   * Active scope for this query. Overrides the scope derived from `cwd` via
   * the store's `scopes:` config. When neither resolves, no scope filtering
   * happens at all.
   */
  scope?: string;
  /** v0.11 — which surface issued this search, stamped onto the usage log rows. Defaults to 'cli'. */
  surface?: UsageSurface;
}

/**
 * v0.5 Phase 2 — drop a record when `asOf` is set and lies outside the
 * record's validity window. Missing bounds are treated as open-ended
 * (`-Infinity` for `valid_from`, `+Infinity` for `valid_to`), so a record
 * with no validity fields is always returned. Returns `true` to keep the
 * record, `false` to drop it.
 */
export function isValidAsOf(item: MemoryItem, asOf: Date): boolean {
  if (item.valid_from !== undefined) {
    const from = Date.parse(item.valid_from);
    if (!Number.isNaN(from) && asOf.getTime() < from) return false;
  }
  if (item.valid_to !== undefined) {
    const to = Date.parse(item.valid_to);
    if (!Number.isNaN(to) && asOf.getTime() > to) return false;
  }
  return true;
}

/**
 * One result row, shared by every search consumer (CLI text, CLI JSON,
 * MCP structuredContent). The single search payload is the contract.
 */
export interface SearchResult {
  id: string;
  type: MemoryType | 'observation' | 'question';
  title: string;
  /**
   * v0.6 Phase 1 — lifecycle state of the surfaced record. Seeds are always
   * `active`; expansion hits may be `superseded` when `includeSuperseded`
   * is set. Surfaced on every row so callers can distinguish current claims
   * from archive context without a second lookup. Widened to `RecordState`
   * so it stays assignable from `MemoryItem.state` as the schema grows.
   */
  state: RecordState;
  verified_with: VerifiedWith;
  created: string;
  last_verified: string;
  source: string;
  tags: string[];
  stale: boolean;
  /**
   * Aging signal: present (`true`) only on an active claim witnessed by
   * `assertion` alone whose `last_verified` (else `created`) is older than the
   * config's `aging_days` (default 90). Independent of `check_by` — a hit can
   * be `stale: false` and still `aged: true`. Never set on `check_by: "never"`
   * pins or on rows already `stale: true`. See `agingOf` in decay.ts.
   */
  aged?: true;
  /** Whole days since `last_verified` (else `created`); present exactly when `aged` is. */
  unverified_days?: number;
  conflicts_with: string[];
  /** v0.4 typed relation edges — ids of records this hit refines/supports/depends on. */
  refines: string[];
  supports: string[];
  depends_on: string[];
  preview: string;
  body?: string; // present only when full=true and within the budget
  /**
   * v0.5 Phase 1: present on hits surfaced via typed-edge expansion. Absent
   * on seed hits (BM25/dense direct matches). When a record appears in both
   * the seed set and the expansion frontier, the seed entry wins and this
   * field is omitted — the dedupe rule keeps the BM25 score visible.
   */
  expanded_via?: ExpansionHit;
  /**
   * DEFECT B — read-path anchor drift. Present only on active anchored records:
   * `drifted` is true when an anchored file changed or went missing within an
   * available repo; `anchor_unchecked` is true when at least one anchor could
   * not be checked (repo not checked out). Both absent on unanchored records.
   * Each `drift` entry's `compared_to` names what the recorded blob was
   * compared against: the remote default branch (`origin/main`) or `worktree`.
   */
  drifted?: boolean;
  anchor_unchecked?: boolean;
  drift?: DriftEntry[];
  /** v0.11 — most recent retrieval timestamp for this id, when it has ever been retrieved before. */
  last_referenced?: string;
  /** v0.11 — distinct session count that retrieved this id, when known. */
  sessions?: number;
  /**
   * v0.11 — the store layer this hit came from, when the store is layered and
   * the hit is served from a NON-primary layer (e.g. a read-only team store).
   * Absent on hits from the primary/writable layer and on every single-store
   * read, so single-store retrieval stays byte-identical. Propagated straight
   * from `MemoryItem.layer`, which `CompositeStore.stampLayer` sets.
   */
  layer?: string;
  /**
   * v0.11 — procedures only, present only when non-empty. Step labels a
   * human must perform; mirrors the `requires_human` frontmatter field.
   */
  requires_human?: string[];
  /**
   * v0.11 — true when the record carries at least one `derived_from` edge
   * (computed via the shared `isDerived()` helper). Absent (not `false`) on
   * records that aren't derived, matching the rest of the optional-field
   * convention on this row.
   */
  derived?: boolean;
  /** v0.11 — questions only. True = the listed answers are the only candidates (closed world). */
  closed?: boolean;
  /** v0.11 — questions only. Competing answer record ids. */
  answers?: string[];
  /** v0.11 — questions only. Set to the surviving answer id once resolved. */
  resolved_by?: string;
}

/**
 * DEFECT C — how well the store actually covers this query.
 * `none`  = zero active records match the query in scope.
 * `weak`  = matches exist but are low-signal: fewer than half of the distinct
 *           content-bearing query terms occur (whole-token, index-tokenised) in
 *           the best-covered hit, or no hit carries every query term and the
 *           best-covered one carries under three quarters of the content terms,
 *           or the top BM25 is above the weak threshold, or the best-covered hit
 *           matched only via title/tags with no query term in its body. Do not
 *           infer from rank.
 * `ok`    = a genuine match exists.
 */
export type Coverage = 'none' | 'weak' | 'ok';

export interface SearchPayload {
  query: string;
  profile: string;
  count: number;
  full: boolean;
  results: SearchResult[];
  coverage: Coverage;
  coverage_note: string;
  /** Strongest witness tier among the returned hits (anchor > operator > evidence > assertion); null when none. */
  coverage_witness: VerifiedWith | null;
  /**
   * Present when `coverage_witness` was reached by tiering an anchor DOWN: the
   * strongest row is anchored but its anchor is `drifted` (code changed) or
   * `anchor_unchecked` (repo not checked out), so it counts as `evidence`, and
   * the text line says so ("best witness: evidence (drifted)"). Absent when the
   * strongest witness stands on its own.
   */
  coverage_witness_note?: 'drifted' | 'anchor unchecked';
  /**
   * Configured store layers whose directory is absent on this machine, so
   * their records are missing from this result set. Present only when
   * non-empty: a `coverage: none` with a layer listed here is "the team store
   * is not checked out", not "nobody recorded this".
   */
  layers_unavailable?: Array<{ name: string; path: string; writable: boolean }>;
  /**
   * Configured store layers read from a git checkout that is off its remote
   * default branch or behind it (local refs, as of the last fetch), so their
   * records may be older than what the team has merged. Present only when
   * non-empty. `branch` is the short sha for a detached HEAD.
   */
  layers_stale?: StaleLayer[];
}

/**
 * Weak-coverage BM25 cut. bm25() is negative, lower = better. Calibrated on the
 * fixture stores (test/fixtures + the temp stores the search tests build):
 * single-common-token, body-only hits scored about -0.5, while every real
 * title-token or multi-term hit scored -0.95 or better (more negative). -0.7
 * splits those with margin and errs toward `ok` — it only flags the clear noise
 * tail, leaving legitimate single-term title matches as `ok`. The body-match
 * signal below is the corpus-size-independent backstop, since absolute BM25
 * shifts with IDF as the store grows.
 */
const WEAK_BM25_THRESHOLD = -0.7;

/**
 * Scores between this and 0 are treated as no signal, not as a weak match. At
 * tiny corpus sizes BM25's IDF term collapses to log(1) = 0 (e.g. N=2, term in
 * 1 doc), which surfaces as a near-zero score (~-1e-6 after float math) even for
 * a strong title hit. The body-match test decides those cases instead.
 */
const BM25_NEGLIGIBLE = -1e-3;

/**
 * Share of the distinct content terms the best hit must carry for a page of
 * partial-term (OR top-up) matches to read `ok`. Calibrated on a 2.4k-record
 * real store with 100 natural and 100 paraphrased queries (one known target
 * each, 50-row pages): at 0.75 every natural query whose target made the top
 * 10 stayed `ok`, while 32 of the 41 paraphrases whose target did not read
 * `weak` (all 41 read `ok` before match tiers existed).
 */
const PARTIAL_MATCH_OK_RATIO = 0.75;

/** Witness strength order for coverage_witness (lower index = stronger). */
const WITNESS_STRENGTH: Record<VerifiedWith, number> = {
  anchor: 0,
  probe: 1,
  operator: 2,
  evidence: 3,
  assertion: 4,
};

/**
 * Token budget for full bodies — chars/4 heuristic, no tokenizer dependency.
 * Matches the heuristic used in context.ts for consistency.
 */
const FULL_BODY_TOKEN_BUDGET = 2000;
const PREVIEW_CHARS = 160;

function assertMemoryType(input: string): MemoryType {
  if ((MEMORY_TYPES as readonly string[]).includes(input)) {
    return input as MemoryType;
  }
  throw new Error(`Unsupported memory type: ${input}`);
}

function parseProfileTypes(types?: string[]): MemoryType[] | undefined {
  if (!types || types.length === 0) return undefined;
  return types.filter((type): type is MemoryType => (MEMORY_TYPES as readonly string[]).includes(type));
}

function previewFromBody(body: string, limit = PREVIEW_CHARS): string {
  const lines = body.split('\n').filter((line) => !line.startsWith('#'));
  return lines.join(' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function witnessOf(item: MemoryItem): VerifiedWith {
  if (item.verified_with) return item.verified_with;
  if (item.anchors && item.anchors.length > 0) return 'anchor';
  return 'assertion';
}

/**
 * Cheap pairwise conflict surface within a result set: declared conflicts_with
 * is honoured directly; same-type, same-tag, overlapping-title pairs that aren't
 * already declared get added so the LLM sees the contradiction even if no
 * supersede has landed yet. Not a replacement for status conflicts — just the
 * "is this result set internally consistent?" pass.
 */
function annotateConflicts(items: MemoryItem[]): Map<string, string[]> {
  const byId = new Map(items.map((item) => [item.id, item]));
  const out = new Map<string, Set<string>>();
  for (const item of items) {
    out.set(item.id, new Set(item.conflicts_with ?? []));
  }

  for (let i = 0; i < items.length; i++) {
    const a = items[i];
    if (!a.type) continue;
    for (let j = i + 1; j < items.length; j++) {
      const b = items[j];
      if (!b.type) continue;
      if (a.type !== b.type) continue;
      // share at least one tag
      if (sharedTagCount(a.tags, b.tags) === 0) continue;
      // title token overlap >= 2 — cheap stand-in for semantic overlap
      if (titleTokenOverlap(a.title, b.title) < 2) continue;
      out.get(a.id)!.add(b.id);
      out.get(b.id)!.add(a.id);
    }
  }

  const result = new Map<string, string[]>();
  for (const [id, set] of out) {
    // Only retain conflicts pointing at items the consumer will actually see.
    const filtered = [...set].filter((cid) => byId.has(cid) || (items.find((i) => i.id === id)?.conflicts_with ?? []).includes(cid));
    result.set(id, filtered);
  }
  return result;
}

/**
 * Build a SearchResult row from a MemoryItem. Shared between the seed pass
 * and the expansion pass so both shape consistently — the only difference is
 * the optional `expanded_via` field set by the caller.
 */
function buildResultRow(
  item: MemoryItem,
  conflicts: ReadonlyMap<string, string[]>,
  full: boolean,
  budget: { used: number; limit: number },
): SearchResult {
  const result: SearchResult = {
    id: item.id,
    type: item.type ?? 'observation',
    title: item.title,
    state: item.state,
    verified_with: witnessOf(item),
    created: item.created,
    last_verified: item.last_verified ?? item.created,
    source: item.source,
    tags: item.tags,
    stale: item.stale ?? false,
    conflicts_with: conflicts.get(item.id) ?? [],
    refines: item.refines ?? [],
    supports: item.supports ?? [],
    depends_on: item.depends_on ?? [],
    preview: previewFromBody(item.body),
  };

  // Read-time only: present when the composite served this record from a
  // non-primary layer. Never serialized back to frontmatter.
  if (item.layer !== undefined) {
    result.layer = item.layer;
  }

  if (item.requires_human && item.requires_human.length > 0) {
    result.requires_human = item.requires_human;
  }
  if (isDerived(item)) {
    result.derived = true;
  }

  if (full) {
    const cost = estimateTokens(item.body);
    if (budget.used + cost <= budget.limit) {
      result.body = item.body;
      budget.used += cost;
    }
  }

  return result;
}

/**
 * v0.11 — build a `SearchResult` row for a question record. Distinct from
 * `buildResultRow` because a question has no meaningful lexical body (it's
 * always `# <title>`) and no conflicts/refines/supports/depends_on edges —
 * its only relations are its `answers`.
 */
function buildQuestionResultRow(
  item: MemoryItem,
  full: boolean,
  budget: { used: number; limit: number },
): SearchResult {
  const result: SearchResult = {
    id: item.id,
    type: 'question',
    title: item.title,
    state: item.state,
    verified_with: witnessOf(item),
    created: item.created,
    last_verified: item.last_verified ?? item.created,
    source: item.source,
    tags: item.tags,
    stale: item.stale ?? false,
    conflicts_with: [],
    refines: [],
    supports: [],
    depends_on: [],
    preview: previewFromBody(item.body),
    closed: item.closed === true,
    answers: item.answers ?? [],
    resolved_by: item.resolved_by,
  };

  if (item.layer !== undefined) {
    result.layer = item.layer;
  }

  if (full) {
    const cost = estimateTokens(item.body);
    if (budget.used + cost <= budget.limit) {
      result.body = item.body;
      budget.used += cost;
    }
  }

  return result;
}

/**
 * v0.11 — `--type question` search path. Bypasses `store.search()` (which is
 * built on the active-only FTS pool, and a question never carries `state:
 * active`) and lists question records directly: open first, then resolved,
 * each group newest-created-first. A non-empty query filters by a
 * case-insensitive substring match against the title — the only free text a
 * question carries worth matching against.
 */
function questionSearchPayload(
  query: string,
  options: SearchOptions,
  store: CompositeStore,
  profileName: string,
  activeScope: string | undefined,
  limit: number,
): SearchPayload {
  const seen = new Set<string>();
  const questions: MemoryItem[] = [];
  for (const item of store.loadAll()) {
    if (item.kind !== 'question') continue;
    if (seen.has(item.id)) continue; // higher-priority layer already claimed this id
    if (!isVisibleFromScope(item.scope, activeScope)) continue;
    seen.add(item.id);
    questions.push(item);
  }

  const needle = query.trim().toLowerCase();
  const matched = needle.length === 0
    ? questions
    : questions.filter((item) => item.title.toLowerCase().includes(needle));

  matched.sort((a, b) => {
    if (a.state !== b.state) return a.state === 'open' ? -1 : 1; // open before resolved
    return Date.parse(b.created) - Date.parse(a.created); // newest first within a group
  });

  const full = options.full === true;
  const budget = { used: 0, limit: FULL_BODY_TOKEN_BUDGET };
  const results = matched.slice(0, limit).map((item) => buildQuestionResultRow(item, full, budget));

  if (results.length > 0) {
    recordSurfacedHitsByLayer(store, results, { query, surface: options.surface ?? 'cli' });
  }

  const scopeLabel = activeScope ?? 'any';
  const coverage: Coverage = results.length > 0 ? 'ok' : 'none';
  const coverage_note = results.length > 0
    ? `${results.length} question group(s) matched`
    : `no question group matches this query in scope ${scopeLabel}`;

  return {
    query,
    profile: profileName,
    count: results.length,
    full,
    results,
    coverage,
    coverage_note,
    coverage_witness: strongestWitness(results).tier,
    ...layerHealth(store),
  };
}

/**
 * Single search entry point. Both CLI and MCP read from this payload — no
 * second `store.search` call to keep them in sync.
 */
export function searchPayload(query: string, options: SearchOptions): SearchPayload {
  // v0.6.1 (#2): wrap in CompositeStore so configured `stores:` layers surface
  // in retrieval. When no layering is configured this is a single-layer
  // composite over the project store — byte-identical to v0.6 behaviour.
  const store = CompositeStore.forCwd(options.cwd);
  const config = loadConfig(store.root);
  const profileName = options.profile ?? 'default';
  const profile = getProfile(config, profileName);

  const limit = parseInt(options.limit ?? '10', 10);
  if (Number.isNaN(limit) || limit < 1) {
    throw new Error(`Invalid limit: ${options.limit}`);
  }

  // Active scope: stated by the caller, or derived from cwd via `scopes:`.
  // Undefined (no config, or a cwd nothing claims) means no filtering — a
  // store without scoping behaves exactly as it did before scopes existed.
  const activeScope = options.scope !== undefined
    ? assertKnownScope(config.scopes, options.scope, () => store.scopesInUse())
    : resolveScopeForCwd(config.scopes, resolve(options.cwd ?? process.cwd()));

  // v0.11 — `--type question` bypasses the FTS/BM25 pipeline entirely: a
  // question record never carries `state: active` (it lives in `open` /
  // `resolved`), so the normal path — built on `store.search()`'s
  // active-only candidate pool — can never surface it no matter how `types`
  // is filtered. This is the only path that returns question records; a
  // default (untyped) search keeps excluding them.
  if (options.type === 'question') {
    return questionSearchPayload(query, options, store, profileName, activeScope, limit);
  }

  const explicitType = options.type ? assertMemoryType(options.type) : undefined;
  const types = explicitType ? [explicitType] : parseProfileTypes(profile.types);

  const storeOptions: StoreSearchOptions = {
    limit,
    types,
    scope: activeScope,
    ranking: profile.ranking,
  };
  // v0.5 Phase 2 — temporal validity filter. Parse asOf up front (before the
  // store query) so a bad ISO string fails the request loudly rather than
  // silently letting every record through (which would be the behaviour of
  // NaN comparisons).
  let asOfDate: Date | undefined;
  if (options.asOf !== undefined) {
    asOfDate = new Date(options.asOf);
    if (Number.isNaN(asOfDate.getTime())) {
      throw new Error(`Invalid as_of timestamp: ${options.asOf} (must be ISO 8601)`);
    }
  }

  const relevanceMeta: SearchRelevanceMeta = { topBm25: null };
  let items = store.search(query, storeOptions, relevanceMeta);
  if (asOfDate !== undefined) {
    items = items.filter((item) => isValidAsOf(item, asOfDate));
  }

  // v0.5 Phase 1: optional graph expansion. We load the active set once and
  // pass it to the walker via a Map<id, item>. The walker is bounded
  // (depth + maxExpansion), so even on a thousand-record store the extra
  // load is dominated by the existing FTS pass.
  //
  // v0.6 Phase 1: when `includeSuperseded` is set, the map also carries
  // archived (superseded) records so the walker can resolve edge targets
  // that point into the archive. Active records still take priority on id
  // collisions (shouldn't happen — ids are stable across the lifecycle —
  // but the spread order documents intent).
  const expandEdges = options.expandEdges === true;
  const includeSuperseded = options.includeSuperseded === true;
  let expansionHits: ExpansionHit[] = [];
  let expansionRecordsById: Map<string, MemoryItem> | undefined;
  if (expandEdges && items.length > 0) {
    const activeItems = store.loadActive();
    const walkPool: MemoryItem[] = includeSuperseded
      ? [...store.loadSuperseded(), ...activeItems]
      : activeItems;
    // The seed pass is scope-filtered inside SQL; the expansion pass reads its
    // own pool, so without this the filter is bypassed entirely — a hit in
    // scope A follows a `refines` edge and returns a record from scope B.
    //
    // Out-of-scope records are a HARD WALL, not merely excluded from the
    // results: they're removed from the pool, so the walker can neither
    // surface them nor traverse THROUGH them. The alternative (traversable
    // but unreturnable) leaks the foreign graph's shape — at depth 2-3 the
    // neighbours of a record you're not allowed to see get pulled in, so the
    // existence and connectivity of another project's knowledge is inferable
    // from your own result set, and one project's edge edits silently change
    // another's retrieval. The disconnection risk is bounded: unscoped and
    // `universal` records stay visible from every scope, so the only paths
    // this severs are ones that route through a genuinely foreign record —
    // which is precisely the partition the feature exists to enforce.
    const recordsForWalk = walkPool.filter((item) => isVisibleFromScope(item.scope, activeScope));
    expansionRecordsById = new Map(recordsForWalk.map((item) => [item.id, item]));
    const edgeTypes = options.edgeTypes && options.edgeTypes.length > 0
      ? options.edgeTypes
      : EDGE_TYPES;
    expansionHits = expandGraph(
      items.map((item) => item.id),
      expansionRecordsById,
      {
        edgeTypes,
        maxDepth: options.expandDepth ?? 1,
      },
    );
  }

  // Conflicts annotation runs across the union of seed + expansion items so
  // pairwise conflict surfacing still works when an expansion drags in a
  // sibling claim. Expansion hits with unresolved ids (not in the map) are
  // skipped silently — the walker may surface them as raw ids, but we can't
  // build a result row without a record.
  const expansionItems: MemoryItem[] = [];
  const seedIdSet = new Set(items.map((i) => i.id));
  for (const hit of expansionHits) {
    if (seedIdSet.has(hit.id)) continue; // dedupe: seed wins
    const record = expansionRecordsById?.get(hit.id);
    if (!record) continue;
    expansionItems.push(record);
  }
  const conflicts = annotateConflicts([...items, ...expansionItems]);

  const full = options.full === true;
  const budget = { used: 0, limit: FULL_BODY_TOKEN_BUDGET };

  const results: SearchResult[] = items.map((item) => buildResultRow(item, conflicts, full, budget));

  // Append expansion hits in the order produced by the walker (BFS, so closer
  // hops first; edge-type order is the order the caller supplied). The seed
  // dedupe above already filtered hits whose id appears in the seed set.
  if (expansionHits.length > 0 && expansionRecordsById) {
    const seen = new Set(results.map((r) => r.id));
    // A record reachable along multiple edges in the same hop is surfaced
    // once, keyed by the first-walked edge. This mirrors the BFS visited-set
    // semantics in graph-walk.ts.
    for (const hit of expansionHits) {
      if (seen.has(hit.id)) continue;
      const record = expansionRecordsById.get(hit.id);
      if (!record) continue;
      const row = buildResultRow(record, conflicts, full, budget);
      row.expanded_via = hit;
      results.push(row);
      seen.add(hit.id);
    }
  }

  // DEFECT B — annotate read-path drift onto the active anchored rows. Bounded
  // to the returned set; never throws; memoized SHAs keep a long-lived MCP
  // server from re-hashing stable files per query.
  const driftById = store.annotateDrift([...items, ...expansionItems]);
  for (const row of results) {
    const drift = driftById.get(row.id);
    if (!drift) continue;
    row.drifted = drift.drifted;
    row.anchor_unchecked = drift.anchor_unchecked;
    if (drift.drift.length > 0) row.drift = drift.drift;
  }

  // Aging signal — an assertion-only claim nobody has re-verified in
  // `aging_days`. Joined on the same witness the row displays, so a row never
  // reads `(assertion)` without the age check, or `(anchor)` with it.
  const agingDays = getAgingDays(config);
  const surfacedById = new Map([...items, ...expansionItems].map((i) => [i.id, i]));
  for (const row of results) {
    const item = surfacedById.get(row.id);
    const aging = item ? agingOf(item, row.verified_with, agingDays) : null;
    if (!aging) continue;
    row.aged = aging.aged;
    row.unverified_days = aging.unverified_days;
  }

  // v0.11 — surface last_referenced/sessions when this id has prior usage-log
  // history. Never written back to frontmatter; purely a read-side join.
  const usageStats = computeUsageStats(store.root);
  for (const row of results) {
    const stat = usageStats.get(row.id);
    if (!stat || !stat.last_referenced) continue;
    row.last_referenced = stat.last_referenced;
    row.sessions = stat.sessions;
  }

  if (results.length > 0) {
    recordSurfacedHitsByLayer(store, results, { query, surface: options.surface ?? 'cli' });
  }

  // DEFECT C — coverage disclosure, judged on the SEED matches (direct query
  // hits), not the expansion frontier. Expansion only runs when seeds exist, so
  // zero seeds == zero results == no coverage.
  const coverageWitness = strongestWitness(results);
  // A type filter only NARROWS when it leaves some claim type out; the default
  // profile's `types: [fact, decision, procedure]` is every claim type and is
  // not worth naming in the note.
  const narrowingTypes = types && types.length > 0 && MEMORY_TYPES.some((t) => !types.includes(t))
    ? types
    : undefined;
  const classified = classifyCoverage(query, items, relevanceMeta, activeScope, narrowingTypes);
  const coverage = classified.coverage;
  let coverage_note = classified.coverage_note;

  // A type filter (explicit `--type`, or the profile's `types:`) can be the
  // only reason a query reads none/weak. One extra FTS pass — only in that
  // case, and only when a narrowing filter is active — says whether records
  // of OTHER types match, so the agent knows to retry without the filter
  // instead of concluding "nothing here".
  if (coverage !== 'ok' && narrowingTypes) {
    const typeSet = new Set<string>(narrowingTypes);
    let others = 0;
    try {
      others = store.search(query, { ...storeOptions, types: undefined })
        .filter((item) => !typeSet.has(item.type ?? 'observation')).length;
    } catch {
      others = 0; // the unfiltered probe is advisory; never fail the search over it
    }
    if (others > 0) {
      coverage_note += `; ${others} record(s) of other types match — retry without the type filter`;
    }
  }

  return {
    query,
    profile: profileName,
    count: results.length,
    full,
    results,
    coverage,
    coverage_note,
    coverage_witness: coverageWitness.tier,
    ...(coverageWitness.note !== undefined ? { coverage_witness_note: coverageWitness.note } : {}),
    ...layerHealth(store),
  };
}

/**
 * `layers_unavailable` / `layers_stale`, each present only when non-empty.
 * Shared by the record and the question search paths so neither drops a
 * layer warning the other carries.
 */
function layerHealth(store: CompositeStore): Pick<SearchPayload, 'layers_unavailable' | 'layers_stale'> {
  const staleLayers = store.staleLayers();
  return {
    ...(store.layersUnavailable.length > 0 ? { layers_unavailable: store.unavailableLayers() } : {}),
    ...(staleLayers.length > 0 ? { layers_stale: staleLayers } : {}),
  };
}

/**
 * v0.11 — a derived record (any `derived_from` edge) counts one witness tier
 * WEAKER than its stated `verified_with` for `coverage_witness` purposes: the
 * record's own witness only attests to how the inference step was checked,
 * not to the ground truth its premises rest on, so treating it at face value
 * would overstate the result set's evidentiary strength. Ladder is the
 * existing `VERIFIED_WITH` order (anchor > probe > operator > evidence >
 * assertion); `assertion` is already the floor and stays `assertion`.
 */
function coverageWitnessTier(r: SearchResult): { tier: VerifiedWith; note?: SearchPayload['coverage_witness_note'] } {
  let tier = r.verified_with;
  let note: SearchPayload['coverage_witness_note'];
  // An anchor only witnesses the code it was taken against. Once that code has
  // changed (drifted) or cannot be seen here (unchecked), the row's own warning
  // says "verify or supersede" — the summary must not outrank it by still
  // reporting `anchor`. The recorded SHA still counts as evidence of what was
  // once observed, so it lands on `evidence`, not the floor.
  if (tier === 'anchor' && (r.drifted === true || r.anchor_unchecked === true)) {
    tier = 'evidence';
    note = r.drifted === true ? 'drifted' : 'anchor unchecked';
  }
  if (r.derived) {
    const idx = VERIFIED_WITH.indexOf(tier);
    tier = VERIFIED_WITH[Math.min(idx + 1, VERIFIED_WITH.length - 1)];
  }
  return { tier, note };
}

/**
 * Strongest witness tier among the returned rows (null when there are none).
 * On a tie between a row that reached the tier on its own and one that was
 * tiered down from a drifted/unchecked anchor, the self-standing row wins and
 * no note is attached.
 */
function strongestWitness(results: SearchResult[]): { tier: VerifiedWith | null; note?: SearchPayload['coverage_witness_note'] } {
  let best: { tier: VerifiedWith; note?: SearchPayload['coverage_witness_note'] } | null = null;
  for (const r of results) {
    const cand = coverageWitnessTier(r);
    if (best === null || WITNESS_STRENGTH[cand.tier] < WITNESS_STRENGTH[best.tier]) {
      best = cand;
    } else if (WITNESS_STRENGTH[cand.tier] === WITNESS_STRENGTH[best.tier] && best.note && !cand.note) {
      best = cand;
    }
  }
  return best ?? { tier: null };
}

/** One coverage term: the index token to test for, and the raw word to print. */
interface CoverageTerm {
  token: string;
  label: string;
}

/**
 * Distinct content-bearing query terms, in query order. `rawWords` is the
 * whitespace split of the lowercased query; `rawTokens[i]` is what the index
 * tokenizer makes of `rawWords[i]` (punctuation and quotes gone, stemmed).
 * Stopwords and words shorter than 3 characters are dropped on the RAW word,
 * so `use` (stem `us`) is excluded for being a function word, not for its stem
 * length. Distinctness is by token, so `tariff` and `tariffs` count once.
 */
function coverageTerms(rawWords: string[], rawTokens: string[][]): CoverageTerm[] {
  const seen = new Set<string>();
  const out: CoverageTerm[] = [];
  rawWords.forEach((raw, i) => {
    const label = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (label.length < 3 || COVERAGE_STOPWORDS.has(label)) return;
    const tokens = rawTokens[i];
    for (const token of tokens) {
      if (seen.has(token)) continue;
      seen.add(token);
      out.push({ token, label: tokens.length === 1 ? label : token });
    }
  });
  return out;
}

/** Per-seed sets of the query tokens each seed contains, tokenised by the index tokenizer. */
interface SeedTokens {
  item: MemoryItem;
  /** title + tags + body */
  all: Set<string>;
  body: Set<string>;
}

function classifyCoverage(
  query: string,
  seeds: MemoryItem[],
  meta: SearchRelevanceMeta,
  scope: string | undefined,
  types: readonly string[] | undefined,
): { coverage: Coverage; coverage_note: string } {
  const scopeLabel = scope ?? 'any';
  const typeLabel = types && types.length > 0 ? `${types.join('/')} ` : '';
  if (seeds.length === 0) {
    return {
      coverage: 'none',
      coverage_note: `no active ${typeLabel}record matches this query in scope ${scopeLabel}`,
    };
  }
  // weak/ok notes name the scope only when one is active — a store without
  // scoping keeps the pre-0.11 wording byte-for-byte.
  const inScope = scope !== undefined ? ` in scope ${scope}` : '';

  // Tokenise the query words and every seed with the SAME tokenizer the index
  // uses (unicode61 separators + porter), in one throwaway FTS5 pass, so the
  // term test below is a whole-token comparison that agrees with what FTS5
  // matched: `remootio,` ≡ `remootio`, `tariffs` ≡ `tariff`, and `gate` does not
  // match inside `gateway`.
  // Only query tokens are ever looked up in a seed, so the seeds come back as
  // the set of query tokens they contain (`queryTokenPresence`).
  const rawWords = query.toLowerCase().split(/\s+/).filter(Boolean);
  const { queryTokens: rawTokens, present } = queryTokenPresence(
    rawWords,
    seeds.flatMap((s) => [`${s.title} ${s.tags.join(' ')}`, s.body]),
  );
  const seedTokens: SeedTokens[] = seeds.map((item, i) => {
    const titleTags = present[i * 2];
    const body = present[i * 2 + 1];
    return { item, all: new Set([...titleTags, ...body]), body };
  });

  const distinct = coverageTerms(rawWords, rawTokens);
  // Body-probe tokens: the content terms when there are any, else every query
  // token (an all-stopword query still has to be judged on something).
  const probe = distinct.length > 0 ? distinct.map((t) => t.token) : [...new Set(rawTokens.flat())];

  // Coverage is judged on the BEST-COVERED seed, not on seeds[0]. In a layered
  // store the fused rank-1 hit can be a junk OR-fallback row from the higher-
  // priority layer while the exact match sits at #2 (RRF tie broken by layer
  // priority); in a single store BM25 can rank a one-term title hit above a
  // record carrying every term. The question is "does the store cover this
  // query", so the strongest witness among the returned set answers it.
  // Ties go to the better match tier, so a full match is never judged as a partial.
  const tierOf = (s: SeedTokens) => meta.tiers?.get(s.item.id) ?? 1;
  let best = seedTokens[0];
  let bestMatched = -1;
  for (const s of seedTokens) {
    const matched = distinct.filter((t) => s.all.has(t.token)).length;
    if (matched > bestMatched || (matched === bestMatched && tierOf(s) < tierOf(best))) {
      best = s;
      bestMatched = matched;
    }
  }

  // Term-coverage signal (primary, corpus-size-independent). BM25 ranks a record
  // highly for matching ONE distinct term, so a mostly-absent multi-term query
  // ("zebra quantum flamingo tariff") can still surface a genuine-looking hit on
  // "tariff" alone. If under half of the distinct content terms occur in the
  // best-covered hit, the query is only weakly covered regardless of BM25, and
  // the note names what matched nothing.
  if (distinct.length > 1) {
    const unmatched = distinct.filter((t) => !best.all.has(t.token));
    if (bestMatched / distinct.length < 0.5) {
      return {
        coverage: 'weak',
        coverage_note: `${bestMatched} of ${distinct.length} query terms matched${inScope} (unmatched: ${unmatched.map((t) => t.label).join(', ')})`,
      };
    }
  }

  // Match-tier signal. When the best-covered hit is a partial (OR top-up) row,
  // no hit carries more of the query's whole tokens than a record sharing SOME
  // words with it, which is exactly what a query about something the store
  // does not hold returns. That is a genuine match only when that hit still
  // carries most of the content terms (PARTIAL_MATCH_OK_RATIO); otherwise it
  // reads weak, naming the gap. Judged on the best-covered hit, not on "any
  // full match on the page": a prefix-only full match carrying fewer whole
  // tokens must not vouch for a partial row it did not out-cover.
  const fullMatch = tierOf(best) === 1;
  if (!fullMatch && distinct.length > 0 && bestMatched / distinct.length < PARTIAL_MATCH_OK_RATIO) {
    const unmatched = distinct.filter((t) => !best.all.has(t.token));
    return {
      coverage: 'weak',
      coverage_note: `only partial-term matches${inScope}: best hit carries ${bestMatched} of ${distinct.length} query terms (unmatched: ${unmatched.map((t) => t.label).join(', ')}); do not infer from rank`,
    };
  }

  // BM25 tail signal, corpus-size-guarded. bm25() is negative (lower = better);
  // a score in (WEAK_BM25_THRESHOLD, BM25_NEGLIGIBLE) is a real but barely-there
  // match. Scores above BM25_NEGLIGIBLE are the degenerate near-zero (see the
  // constant) and carry no signal — the body-match test decides those.
  const bm25Weak = meta.topBm25 !== null && meta.topBm25 < BM25_NEGLIGIBLE && meta.topBm25 > WEAK_BM25_THRESHOLD;
  // Corpus-size-independent signal: the best-covered hit matched only via its
  // title or tags, with no query token in its body. This is the "indirect
  // match" case.
  const bodyOnlyTagTitle = !probe.some((token) => best.body.has(token));

  if (bm25Weak || bodyOnlyTagTitle) {
    return {
      coverage: 'weak',
      coverage_note: `only low-relevance matches${inScope}; do not infer from rank`,
    };
  }

  return { coverage: 'ok', coverage_note: `at least one genuine match${inScope}` };
}

/**
 * CLI text/JSON formatter. Reads the same payload the MCP returns, so the
 * structured shape and the text rendering can never drift.
 */
/**
 * The final `Coverage:` line shared by the CLI and the MCP text renderer.
 * Carries the deterministic coverage class, its note, and (for weak/ok) the
 * strongest witness backing the result set, so "the store has this but only as
 * an unverified assertion" is visible without reading every row.
 */
export function formatCoverageLine(payload: SearchPayload): string {
  const witnessNote = payload.coverage_witness_note ? ` (${payload.coverage_witness_note})` : '';
  const witness = payload.coverage_witness ? ` (best witness: ${payload.coverage_witness}${witnessNote})` : '';
  const missing = (payload.layers_unavailable ?? []).map(
    (l) => `Warning: store layer '${l.name}'${l.writable ? '' : ' (read-only)'} is not available at ${l.path}; its records are missing from this view`,
  );
  const stale = (payload.layers_stale ?? []).map((l) => `Warning: store layer ${describeStaleLayer(l)}; its records may be outdated`);
  const line = payload.coverage === 'none'
    ? `Coverage: none — ${payload.coverage_note}`
    : `Coverage: ${payload.coverage} — ${payload.coverage_note}${witness}`;
  return [line, ...missing, ...stale].join('\n');
}

/** Text-renderer marker for the aging signal; empty when the row is not aged. Shared with the MCP text renderer. */
export function agedTag(row: Pick<SearchResult, 'aged' | 'unverified_days'>): string {
  return row.aged ? ` [UNVERIFIED ${row.unverified_days}d — check before relying]` : '';
}

export function runSearch(query: string, options: SearchOptions): string {
  const payload = searchPayload(query, options);

  // `--json` is the SAME payload object the MCP tool returns (`{query, profile,
  // count, full, results, coverage, coverage_note, coverage_witness}`), so a
  // script gets the coverage verdict too. 0.11 breaking change: before this it
  // was a bare results array (and the literal `[]` on zero hits), which made
  // "no results" indistinguishable from "weak" and hid the coverage fields the
  // README promised.
  if (options.json) {
    return JSON.stringify(payload, null, 2);
  }

  if (payload.results.length === 0) {
    return `No results for "${query}"\n\n${formatCoverageLine(payload)}`;
  }

  const lines: string[] = [`${payload.results.length} result(s) for "${query}"`, ''];

  for (const item of payload.results) {
    const conflictTag = item.conflicts_with.length > 0 ? ` [CONFLICTS WITH ${item.conflicts_with.join(', ')}]` : '';
    const expandedTag = item.expanded_via
      ? ` [via ${item.expanded_via.edge_type} from ${item.expanded_via.from_id} @ hop ${item.expanded_via.hops}]`
      : '';
    const driftTag = item.drifted ? ' [DRIFTED — anchored code changed; verify or supersede]' : '';
    // `layer` is stamped only on hits from a non-primary layer, which only
    // exist when the store is layered — so the suffix appears exactly when
    // more than one layer is configured.
    const layerTag = item.layer ? ` (layer: ${item.layer})` : '';
    const derivedTag = item.derived ? ' (derived)' : '';
    lines.push(`[${item.type}] ${item.title} (${item.verified_with})${derivedTag}${item.stale ? ' [STALE — verify or supersede before relying on this]' : ''}${agedTag(item)}${driftTag}${conflictTag}${expandedTag}${layerTag}`);
    lines.push(`  ${item.id} | ${item.created.substring(0, 10)} | ${item.source}`);
    if (item.tags.length > 0) {
      lines.push(`  tags: ${item.tags.join(', ')}`);
    }
    if (item.requires_human && item.requires_human.length > 0) {
      lines.push(`  requires human: ${item.requires_human.join('; ')}`);
    }
    if (item.type === 'question') {
      const resolvedTag = item.resolved_by ? `resolved — resolved_by ${item.resolved_by}` : 'open';
      lines.push(`  ${item.closed ? 'closed' : 'open'}-world | ${resolvedTag} | answers: ${(item.answers ?? []).join(', ') || '(none)'}`);
    }
    if (item.body !== undefined) {
      lines.push(`  ${item.body.split('\n').filter((l) => !l.startsWith('#')).join(' ').trim()}`);
    } else if (item.preview) {
      lines.push(`  ${item.preview.slice(0, 120)}`);
    }
    lines.push('');
  }

  lines.push(formatCoverageLine(payload));

  return lines.join('\n');
}
