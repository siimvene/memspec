import { z } from 'zod';
import { MemspecStore } from '../lib/store.js';
import type { MemoryItem } from '../lib/types.js';

/**
 * v0.4: typed edge kinds writable via `memspec_relate`. Mirrors the
 * MemoryFrontmatter relation fields exactly; keep in sync.
 */
export const RELATION_TYPES = ['refines', 'supports', 'depends_on', 'conflicts_with'] as const;
export type RelationType = typeof RELATION_TYPES[number];

export const relationTypeSchema = z.enum(RELATION_TYPES);

export interface RelateOptions {
  cwd?: string;
  from: string;
  to: string;
  type: RelationType;
}

export interface RelateResult {
  from_id: string;
  to_id: string;
  type: RelationType;
  added: boolean;
  total_edges_of_type: number;
  message: string;
}

/**
 * Append a typed edge from one record to another without rewriting the rest
 * of the record. Dedupes silently — replaying the same call is a no-op.
 *
 * Errors:
 * - Either id missing → throws (404-style; caller surfaces the message).
 * - Unknown type → blocked at the Zod boundary, never reaches this function
 *   when callers route through MCP/CLI; the runtime parse here guards the
 *   library entry point too.
 */
export function runRelate(options: RelateOptions): RelateResult {
  const type = relationTypeSchema.parse(options.type);

  if (!options.from) throw new Error('relate requires --from');
  if (!options.to) throw new Error('relate requires --to');
  if (options.from === options.to) {
    throw new Error(`relate refuses self-edges (${options.from} → ${options.to})`);
  }

  const store = new MemspecStore(options.cwd);

  const from = store.findById(options.from);
  if (!from) throw new Error(`Memory not found: ${options.from}`);

  const to = store.findById(options.to);
  if (!to) throw new Error(`Memory not found: ${options.to}`);

  const existing = readEdges(from, type);
  const already = existing.includes(options.to);
  const next = already ? existing : [...existing, options.to];

  if (!already) {
    store.updateItem(writeEdges(from, type, next));
  }

  const message = already
    ? `Edge already present: ${from.id} -[${type}]-> ${to.id} (no-op)`
    : `Linked ${from.id} -[${type}]-> ${to.id} (now ${next.length} ${type} edge(s))`;

  return {
    from_id: from.id,
    to_id: to.id,
    type,
    added: !already,
    total_edges_of_type: next.length,
    message,
  };
}

function readEdges(item: MemoryItem, type: RelationType): string[] {
  switch (type) {
    case 'refines': return item.refines ?? [];
    case 'supports': return item.supports ?? [];
    case 'depends_on': return item.depends_on ?? [];
    case 'conflicts_with': return item.conflicts_with ?? [];
  }
}

function writeEdges(item: MemoryItem, type: RelationType, edges: string[]): MemoryItem {
  switch (type) {
    case 'refines': return { ...item, refines: edges };
    case 'supports': return { ...item, supports: edges };
    case 'depends_on': return { ...item, depends_on: edges };
    case 'conflicts_with': return { ...item, conflicts_with: edges };
  }
}
