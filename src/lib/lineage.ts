import type { MemoryItem } from './types.js';

export interface LineageEntry {
  id: string;
  state: MemoryItem['state'];
  title: string;
  created: string;
  source: string;
  supersede_reason?: string;
}

export interface Lineage {
  /** Records that this record was built from (walks `supersedes` backward). */
  ancestors: LineageEntry[];
  /** Records that replaced or merged with this one (walks `superseded_by` forward). */
  descendants: LineageEntry[];
}

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
 * Walk the supersede graph in both directions from the given item, returning
 * the lineage chain that explains why this record exists in its current form.
 *
 * - `ancestors` are the records superseded by this one (or by anything in its
 *   own ancestry). Listed in walk order; not deduplicated against cycles
 *   beyond a visited set, since the graph should be a DAG.
 * - `descendants` are the records that replaced this one — useful when looking
 *   up an archived id to find what survives in its place.
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

  return { ancestors, descendants };
}
