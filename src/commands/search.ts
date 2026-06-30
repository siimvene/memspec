import { getProfile, loadConfig } from '../lib/config.js';
import { EDGE_TYPES, expandGraph, type EdgeType, type ExpansionHit } from '../lib/graph-walk.js';
import { sharedTagCount, titleTokenOverlap } from '../lib/inference.js';
import { MemspecStore, type StoreSearchOptions } from '../lib/store.js';
import { MEMORY_TYPES, type LifecycleState, type MemoryItem, type MemoryType, type VerifiedWith } from '../lib/types.js';
import { recordSearchHits } from '../lib/usage.js';

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
   * from archive context without a second lookup.
   */
  state: LifecycleState;
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
}

export interface SearchPayload {
  query: string;
  profile: string;
  count: number;
  full: boolean;
  results: SearchResult[];
}

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
  const store = new MemspecStore(options.cwd);
  const config = loadConfig(store.root);
  const profileName = options.profile ?? 'default';
  const profile = getProfile(config, profileName);

  const limit = parseInt(options.limit ?? '10', 10);
  if (Number.isNaN(limit) || limit < 1) {
    throw new Error(`Invalid limit: ${options.limit}`);
  }

  const explicitType = options.type ? assertMemoryType(options.type) : undefined;
  const types = explicitType ? [explicitType] : parseProfileTypes(profile.types);
  const storeOptions: StoreSearchOptions = {
    limit,
    types,
    minConfidence: profile.min_confidence ?? 0,
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

  let items = store.search(query, storeOptions);
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
    const recordsForWalk: MemoryItem[] = includeSuperseded
      ? [...store.loadSuperseded(), ...activeItems]
      : activeItems;
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

  if (results.length > 0) {
    recordSearchHits(store.root, results.map((r) => r.id));
  }

  return {
    query,
    profile: profileName,
    count: results.length,
    full,
    results,
  };
}

/**
 * CLI text/JSON formatter. Reads the same payload the MCP returns, so the
 * structured shape and the text rendering can never drift.
 */
export function runSearch(query: string, options: SearchOptions): string {
  const payload = searchPayload(query, options);

  if (payload.results.length === 0) {
    return options.json ? '[]' : `No results for "${query}"`;
  }

  if (options.json) {
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
      conflicts_with: r.conflicts_with,
      refines: r.refines,
      supports: r.supports,
      depends_on: r.depends_on,
      ...(r.body !== undefined ? { body: r.body } : {}),
      ...(r.expanded_via !== undefined ? { expanded_via: r.expanded_via } : {}),
    })), null, 2);
  }

  const lines: string[] = [`${payload.results.length} result(s) for "${query}"`, ''];

  for (const item of payload.results) {
    const conflictTag = item.conflicts_with.length > 0 ? ` [CONFLICTS WITH ${item.conflicts_with.join(', ')}]` : '';
    const expandedTag = item.expanded_via
      ? ` [via ${item.expanded_via.edge_type} from ${item.expanded_via.from_id} @ hop ${item.expanded_via.hops}]`
      : '';
    lines.push(`[${item.type}] ${item.title} (${item.verified_with})${item.stale ? ' [STALE — verify or supersede before relying on this]' : ''}${conflictTag}${expandedTag}`);
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

  return lines.join('\n');
}
