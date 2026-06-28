import type { MemoryItem } from './types.js';

export interface LineageEntry {
  id: string;
  state: MemoryItem['state'];
  title: string;
  created: string;
  source: string;
  supersede_reason?: string;
}

/** v0.4: typed-relation chains capture {id,title} only — graph navigation hint, not full record. */
export interface RelationChainEntry {
  id: string;
  title: string;
}

export interface Lineage {
  /** Records that this record was built from (walks `supersedes` backward). */
  ancestors: LineageEntry[];
  /** Records that replaced or merged with this one (walks `superseded_by` forward). */
  descendants: LineageEntry[];
  /** v0.4: outward walk of `refines` up to RELATION_CHAIN_DEPTH. */
  refines_chain: RelationChainEntry[];
  /** v0.4: outward walk of `supports` up to RELATION_CHAIN_DEPTH. */
  supports_chain: RelationChainEntry[];
  /** v0.4: outward walk of `depends_on` up to RELATION_CHAIN_DEPTH. */
  depends_on_chain: RelationChainEntry[];
}

/**
 * v0.4: typed-relation chains walk this many hops outward from the seed before
 * stopping. Three is enough to surface a small neighbourhood without dragging
 * the entire graph into a single `get` response.
 */
export const RELATION_CHAIN_DEPTH = 3;

function toEntry(item: MemoryItem): LineageEntry {
  return {
    id: item.id,
    state: item.state,
    title: item.title,
    created: item.created,
    source: item.source,
    supersede_reason: item.supersede_reason,
  };
}

/**
 * BFS along a single typed-relation field, capped at RELATION_CHAIN_DEPTH hops
 * from the seed. The seed itself is excluded; a visited-set prevents cycles
 * (typed edges are not guaranteed to form a DAG).
 */
function walkRelation(
  seed: MemoryItem,
  byId: Map<string, MemoryItem>,
  field: 'refines' | 'supports' | 'depends_on',
  depth: number = RELATION_CHAIN_DEPTH,
): RelationChainEntry[] {
  const out: RelationChainEntry[] = [];
  const visited = new Set<string>([seed.id]);
  let frontier: string[] = [...(seed[field] ?? [])];

  for (let hop = 0; hop < depth && frontier.length > 0; hop++) {
    const nextFrontier: string[] = [];
    for (const id of frontier) {
      if (visited.has(id)) continue;
      visited.add(id);
      const node = byId.get(id);
      if (!node) continue;
      out.push({ id: node.id, title: node.title });
      for (const child of node[field] ?? []) {
        if (!visited.has(child)) nextFrontier.push(child);
      }
    }
    frontier = nextFrontier;
  }

  return out;
}

/**
 * Walk the supersede graph in both directions from the given item, returning
 * the lineage chain that explains why this record exists in its current form.
 *
 * - `ancestors` are the records superseded by this one (or by anything in its
 *   own ancestry). Listed in walk order; not deduplicated against cycles
 *   beyond a visited set, since the graph should be a DAG.
 * - `descendants` are the records that replaced this one — useful when looking
 *   up an archived id to find what survives in its place.
 * - v0.4: `refines_chain`, `supports_chain`, `depends_on_chain` are bounded
 *   outward walks of the matching typed-relation field (depth
 *   RELATION_CHAIN_DEPTH, cycle-safe via visited set).
 */
export function buildLineage(item: MemoryItem, allItems: MemoryItem[]): Lineage {
  const byId = new Map(allItems.map((i) => [i.id, i]));
  const ancestors: LineageEntry[] = [];
  const descendants: LineageEntry[] = [];
  const visited = new Set<string>([item.id]);

  const ancestorQueue: string[] = [...(item.supersedes ?? [])];
  while (ancestorQueue.length > 0) {
    const id = ancestorQueue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const ancestor = byId.get(id);
    if (!ancestor) continue;
    ancestors.push(toEntry(ancestor));
    if (ancestor.supersedes) {
      for (const parent of ancestor.supersedes) {
        if (!visited.has(parent)) ancestorQueue.push(parent);
      }
    }
  }

  let cursor: MemoryItem | undefined = item;
  while (cursor?.superseded_by) {
    const nextId: string = cursor.superseded_by;
    if (visited.has(nextId)) break;
    visited.add(nextId);
    const next = byId.get(nextId);
    if (!next) break;
    descendants.push(toEntry(next));
    cursor = next;
  }

  return {
    ancestors,
    descendants,
    refines_chain: walkRelation(item, byId, 'refines'),
    supports_chain: walkRelation(item, byId, 'supports'),
    depends_on_chain: walkRelation(item, byId, 'depends_on'),
  };
}
