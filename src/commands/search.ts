import { resolve } from 'node:path';
import { CompositeStore } from '../lib/composite-store.js';
import { getProfile, loadConfig } from '../lib/config.js';
import { EDGE_TYPES, expandGraph, type EdgeType, type ExpansionHit } from '../lib/graph-walk.js';
import { sharedTagCount, titleTokenOverlap } from '../lib/inference.js';
import { assertKnownScope, isVisibleFromScope, resolveScopeForCwd } from '../lib/scope.js';
import { type SearchRelevanceMeta, type StoreSearchOptions } from '../lib/store.js';
import { type DriftStatus } from '../lib/drift.js';
import { MEMORY_TYPES, type MemoryItem, type MemoryType, type RecordState, type VerifiedWith } from '../lib/types.js';
import { recordSearchHits, type UsageSurface } from '../lib/usage.js';
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
  type: MemoryType | 'observation';
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
   */
  drifted?: boolean;
  anchor_unchecked?: boolean;
  drift?: Array<{ file: string; status: DriftStatus }>;
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
}

/**
 * DEFECT C — how well the store actually covers this query.
 * `none`  = zero active records match the query in scope.
 * `weak`  = matches exist but are low-signal: the strongest hit's BM25 is above
 *           the weak threshold, or the best hit matched only via title/tags with
 *           no query term in its body. Do not infer from rank.
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

function witnessOf(item: MemoryItem): VerifiedWith {
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

  const explicitType = options.type ? assertMemoryType(options.type) : undefined;
  const types = explicitType ? [explicitType] : parseProfileTypes(profile.types);

  // Active scope: stated by the caller, or derived from cwd via `scopes:`.
  // Undefined (no config, or a cwd nothing claims) means no filtering — a
  // store without scoping behaves exactly as it did before scopes existed.
  const activeScope = options.scope !== undefined
    ? assertKnownScope(config.scopes, options.scope, () => store.scopesInUse())
    : resolveScopeForCwd(config.scopes, resolve(options.cwd ?? process.cwd()));

  const storeOptions: StoreSearchOptions = {
    limit,
    types,
    minConfidence: profile.min_confidence ?? 0,
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
    recordSearchHits(store.root, results.map((r) => r.id), { query, surface: options.surface ?? 'cli' });
  }

  // DEFECT C — coverage disclosure, judged on the SEED matches (direct query
  // hits), not the expansion frontier. Expansion only runs when seeds exist, so
  // zero seeds == zero results == no coverage.
  const coverageWitness = strongestWitness(results);
  const { coverage, coverage_note } = classifyCoverage(query, items, relevanceMeta, activeScope);

  return {
    query,
    profile: profileName,
    count: results.length,
    full,
    results,
    coverage,
    coverage_note,
    coverage_witness: coverageWitness,
  };
}

/** Strongest witness tier among the returned rows (null when there are none). */
function strongestWitness(results: SearchResult[]): VerifiedWith | null {
  let best: VerifiedWith | null = null;
  for (const r of results) {
    if (best === null || WITNESS_STRENGTH[r.verified_with] < WITNESS_STRENGTH[best]) {
      best = r.verified_with;
    }
  }
  return best;
}

/** Does any raw query term appear as a substring in the item's body? */
function bodyMatchesQuery(item: MemoryItem, terms: string[]): boolean {
  const body = item.body.toLowerCase();
  return terms.some((t) => body.includes(t));
}

/**
 * Light suffix strip approximating the FTS5 `porter` tokenizer, enough that a
 * query term and an inflected form in the text collapse to the same root for
 * the term-coverage test (`tariffs`↔`tariff`, `retries`↔`retri`). Not a full
 * porter implementation — this is a coverage heuristic, not the FTS match.
 */
function coverageStem(term: string): string {
  return term.replace(/(?:ingly|edly|ing|edly|ed|ly|es|s)$/u, '');
}

/** Distinct query terms of length >= 3, lowercased, order-preserving. */
function coverageTerms(query: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of query.toLowerCase().split(/\s+/)) {
    if (t.length >= 3 && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/** A query term occurs in the text if the term or its stem appears as a substring. */
function termOccursIn(term: string, haystack: string): boolean {
  if (haystack.includes(term)) return true;
  const stem = coverageStem(term);
  return stem.length >= 3 && haystack.includes(stem);
}

function classifyCoverage(
  query: string,
  seeds: MemoryItem[],
  meta: SearchRelevanceMeta,
  scope: string | undefined,
): { coverage: Coverage; coverage_note: string } {
  const scopeLabel = scope ?? 'any';
  if (seeds.length === 0) {
    return {
      coverage: 'none',
      coverage_note: `no active record matches this query in scope ${scopeLabel}`,
    };
  }

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const top = seeds[0];

  // Term-coverage signal (primary, corpus-size-independent). BM25 ranks a record
  // highly for matching ONE distinct term, so a mostly-absent multi-term query
  // ("zebra quantum flamingo tariff") can still surface a genuine-looking hit on
  // "tariff" alone. Count the distinct query terms (>=3 chars) that occur in the
  // top hit's title+tags+body; if under half matched, the query is only weakly
  // covered regardless of BM25, and the note names what matched nothing.
  const distinct = coverageTerms(query);
  if (distinct.length > 1) {
    const hay = `${top.title} ${top.tags.join(' ')} ${top.body}`.toLowerCase();
    const unmatched = distinct.filter((t) => !termOccursIn(t, hay));
    const matched = distinct.length - unmatched.length;
    if (matched / distinct.length < 0.5) {
      return {
        coverage: 'weak',
        coverage_note: `${matched} of ${distinct.length} query terms matched (unmatched: ${unmatched.join(', ')})`,
      };
    }
  }

  // BM25 tail signal, corpus-size-guarded. bm25() is negative (lower = better);
  // a score in (WEAK_BM25_THRESHOLD, BM25_NEGLIGIBLE) is a real but barely-there
  // match. Scores above BM25_NEGLIGIBLE are the degenerate near-zero (see the
  // constant) and carry no signal — the body-match test decides those.
  const bm25Weak = meta.topBm25 !== null && meta.topBm25 < BM25_NEGLIGIBLE && meta.topBm25 > WEAK_BM25_THRESHOLD;
  // Corpus-size-independent signal: the best hit matched only via its title or
  // tags, with no query term in its body. This is the "indirect match" case.
  const bodyOnlyTagTitle = !bodyMatchesQuery(top, terms);

  if (bm25Weak || bodyOnlyTagTitle) {
    return {
      coverage: 'weak',
      coverage_note: 'only low-relevance matches; do not infer from rank',
    };
  }

  return { coverage: 'ok', coverage_note: 'at least one genuine match' };
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
  const witness = payload.coverage_witness ? ` (best witness: ${payload.coverage_witness})` : '';
  if (payload.coverage === 'none') {
    return `Coverage: none — ${payload.coverage_note}`;
  }
  return `Coverage: ${payload.coverage} — ${payload.coverage_note}${witness}`;
}

export function runSearch(query: string, options: SearchOptions): string {
  const payload = searchPayload(query, options);

  if (options.json) {
    if (payload.results.length === 0) return '[]';
    return JSON.stringify(payload.results.map((r) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      state: r.state,
      verified_with: r.verified_with,
      created: r.created,
      last_verified: r.last_verified,
      tags: r.tags,
      source: r.source,
      stale: r.stale,
      ...(r.drifted !== undefined ? { drifted: r.drifted } : {}),
      ...(r.anchor_unchecked !== undefined ? { anchor_unchecked: r.anchor_unchecked } : {}),
      ...(r.drift !== undefined ? { drift: r.drift } : {}),
      ...(r.last_referenced !== undefined ? { last_referenced: r.last_referenced } : {}),
      ...(r.sessions !== undefined ? { sessions: r.sessions } : {}),
      ...(r.layer !== undefined ? { layer: r.layer } : {}),
      conflicts_with: r.conflicts_with,
      refines: r.refines,
      supports: r.supports,
      depends_on: r.depends_on,
      ...(r.body !== undefined ? { body: r.body } : {}),
      ...(r.expanded_via !== undefined ? { expanded_via: r.expanded_via } : {}),
    })), null, 2);
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
    lines.push(`[${item.type}] ${item.title} (${item.verified_with})${item.stale ? ' [STALE — verify or supersede before relying on this]' : ''}${driftTag}${conflictTag}${expandedTag}${layerTag}`);
    lines.push(`  ${item.id} | ${item.created.substring(0, 10)} | ${item.source}`);
    if (item.tags.length > 0) {
      lines.push(`  tags: ${item.tags.join(', ')}`);
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
