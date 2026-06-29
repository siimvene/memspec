import type { MemoryFrontmatter } from './types.js';

/**
 * v0.5 Phase 1 — typed edge kinds the graph walker can traverse. Mirrors the
 * full edge vocabulary in MemoryFrontmatter (the four `relate`-writable types
 * plus the supersede DAG pair). Keep in sync with types.ts.
 */
export const EDGE_TYPES = [
  'refines',
  'supports',
  'depends_on',
  'conflicts_with',
  'supersedes',
  'superseded_by',
] as const;
export type EdgeType = typeof EDGE_TYPES[number];

/**
 * Hard cap on traversal depth. Matches the lineage walker's
 * RELATION_CHAIN_DEPTH constant — three hops is enough to surface a small
 * neighbourhood without dragging the whole graph into a single search response.
 */
export const MAX_DEPTH = 3;

/** Default per-walk hard cap on total expansion hits surfaced. */
export const DEFAULT_MAX_EXPANSION = 50;

export interface ExpansionHit {
  /** Memory id of the surfaced record. */
  id: string;
  /** Seed id this expansion originated from (the BFS root that reached it). */
  from_id: string;
  /** Which edge type was traversed in the step that surfaced this record. */
  edge_type: EdgeType;
  /** Hop distance from `from_id`: 1, 2, or 3. */
  hops: number;
}

export interface ExpandGraphOptions {
  /** Edge types to walk, in priority order. Defaults to all six. */
  edgeTypes?: readonly EdgeType[];
  /** BFS depth cap. Defaults to 1. Clamped to [1, MAX_DEPTH]. */
  maxDepth?: number;
  /** Hard cap on total expansion hits returned. Defaults to DEFAULT_MAX_EXPANSION. */
  maxExpansion?: number;
}

/**
 * Read the outbound neighbours of a record along a single edge type. The
 * supersede DAG fields differ in shape (`superseded_by` is a single string,
 * not an array), so they're normalised here so the BFS loop can treat every
 * edge uniformly.
 */
function neighboursAlong(record: MemoryFrontmatter, edgeType: EdgeType): readonly string[] {
  switch (edgeType) {
    case 'refines':
      return record.refines ?? [];
    case 'supports':
      return record.supports ?? [];
    case 'depends_on':
      return record.depends_on ?? [];
    case 'conflicts_with':
      return record.conflicts_with ?? [];
    case 'supersedes':
      return record.supersedes ?? [];
    case 'superseded_by':
      return record.superseded_by ? [record.superseded_by] : [];
  }
}

/**
 * BFS-walk the typed-edge graph outward from a set of seed memory ids and
 * return every reachable record (within the depth cap) as an ExpansionHit.
 *
 * Design notes:
 * - BFS, not DFS — closer hops are returned before further ones, which keeps
 *   the result ordering useful when the caller truncates by maxExpansion.
 * - Visited-set is global across the whole walk (not per-seed), so a record
 *   reachable from two different seeds is surfaced exactly once via the
 *   shortest path that touched it first. This matches the lineage walker
 *   pattern and prevents quadratic blow-up on densely-linked stores.
 * - Seed ids are pre-marked as visited and never appear in the output — they
 *   already arrived via BM25/dense seeding and the caller is responsible for
 *   surfacing them.
 * - Edge types are walked in the order supplied so the output is deterministic
 *   for a fixed input — useful for test assertions and the eventual scoring
 *   tiebreaker.
 * - Missing edge arrays / typoed ids don't crash; they just produce no
 *   expansion along that branch.
 * - The maxExpansion cap short-circuits the BFS as soon as the budget is
 *   exhausted; partial output is preferred over an unbounded walk.
 */
export function expandGraph(
  seedIds: readonly string[],
  records: ReadonlyMap<string, MemoryFrontmatter>,
  options: ExpandGraphOptions = {},
): ExpansionHit[] {
  const edgeTypes = options.edgeTypes && options.edgeTypes.length > 0
    ? options.edgeTypes
    : EDGE_TYPES;
  const maxDepth = Math.max(1, Math.min(options.maxDepth ?? 1, MAX_DEPTH));
  const maxExpansion = options.maxExpansion ?? DEFAULT_MAX_EXPANSION;

  if (seedIds.length === 0 || maxExpansion <= 0) return [];

  const visited = new Set<string>(seedIds);
  const out: ExpansionHit[] = [];

  // Frontier carries the record id plus the seed it was reached from, so
  // every emitted hit can name its origin even after multiple hops.
  interface FrontierEntry {
    id: string;
    fromId: string;
  }
  let frontier: FrontierEntry[] = seedIds.map((id) => ({ id, fromId: id }));

  for (let hop = 1; hop <= maxDepth; hop++) {
    if (frontier.length === 0) break;
    const nextFrontier: FrontierEntry[] = [];

    for (const { id, fromId } of frontier) {
      const record = records.get(id);
      if (!record) continue;

      for (const edgeType of edgeTypes) {
        for (const neighbourId of neighboursAlong(record, edgeType)) {
          if (visited.has(neighbourId)) continue;
          visited.add(neighbourId);

          // Surface the hit even if the target record isn't in the map —
          // an unresolved id is still meaningful context for the caller.
          out.push({ id: neighbourId, from_id: fromId, edge_type: edgeType, hops: hop });

          if (out.length >= maxExpansion) return out;

          // Schedule the next layer regardless of whether the record is
          // resolvable; the layer-2 loop will skip unresolved ids cleanly.
          nextFrontier.push({ id: neighbourId, fromId });
        }
      }
    }

    frontier = nextFrontier;
  }

  return out;
}
