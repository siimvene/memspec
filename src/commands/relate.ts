import { z } from 'zod';
import { effectiveSourceKind } from '../lib/source.js';
import { MemspecStore } from '../lib/store.js';
import type { MemoryItem } from '../lib/types.js';

/**
 * v0.4: typed edge kinds writable via `memspec_relate`. Mirrors the
 * MemoryFrontmatter relation fields exactly; keep in sync.
 */
export const RELATION_TYPES = ['refines', 'supports', 'depends_on', 'conflicts_with'] as const;
export type RelationType = typeof RELATION_TYPES[number];

export const relationTypeSchema = z.enum(RELATION_TYPES);

/**
 * v0.10 — `conflicts_with` edges carry provenance in `ext.edge_sources`:
 * `{ [target_id]: "asserted" }` marks an edge a caller deliberately wired
 * (via relate or `remember --conflicts-with`), distinguishing it from the
 * heuristic edges the removed auto-attach produced. The drain script keeps
 * asserted edges and drops the rest. Only conflict edges are tracked — the
 * positive edge kinds (refines/supports/depends_on) were never inferred.
 */
function markEdgeSource(item: MemoryItem, targetId: string): Record<string, unknown> {
  const ext = { ...(item.ext ?? {}) };
  const edgeSources = { ...((ext.edge_sources as Record<string, string> | undefined) ?? {}) };
  edgeSources[targetId] = 'asserted';
  ext.edge_sources = edgeSources;
  return ext;
}

function unmarkEdgeSource(item: MemoryItem, targetId: string): Record<string, unknown> | undefined {
  if (!item.ext || typeof item.ext.edge_sources !== 'object' || item.ext.edge_sources === null) {
    return item.ext;
  }
  const ext = { ...item.ext };
  const edgeSources = { ...(ext.edge_sources as Record<string, string>) };
  delete edgeSources[targetId];
  if (Object.keys(edgeSources).length === 0) delete ext.edge_sources;
  else ext.edge_sources = edgeSources;
  return Object.keys(ext).length === 0 ? undefined : ext;
}

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
    const updated = writeEdges(from, type, next);
    // Conflict edges written here are asserted by construction — a caller
    // explicitly called relate. Stamp provenance so the drain script spares it.
    if (type === 'conflicts_with') {
      updated.ext = markEdgeSource(from, options.to);
    }
    store.updateItem(updated);
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

export interface UnrelateOptions {
  cwd?: string;
  from: string;
  to: string;
  type: RelationType;
  /** Durable reason for the removal; logged into `ext.edge_removals`. Required. */
  reason: string;
  source?: string;
  /** Required to remove an edge from an operator-sourced record. */
  overrideOperator?: boolean;
}

export interface UnrelateResult {
  from_id: string;
  to_id: string;
  type: RelationType;
  removed: boolean;
  total_edges_of_type: number;
  message: string;
}

/**
 * Remove a typed edge from a record — the symmetric inverse of `relate`, and
 * the first edge-retraction path in memspec (edges were append-only before
 * v0.10, so every bad edge was permanent). Refuses on operator-sourced records
 * unless `overrideOperator`, mirroring `supersede`'s protection. Every removal
 * is logged into `ext.edge_removals` (who, when, why) so the retraction is
 * itself auditable. Removing an absent edge is a reported no-op, not an error.
 */
export function runUnrelate(options: UnrelateOptions): UnrelateResult {
  const type = relationTypeSchema.parse(options.type);

  if (!options.from) throw new Error('unrelate requires --from');
  if (!options.to) throw new Error('unrelate requires --to');
  if (!options.reason || !options.reason.trim()) {
    throw new Error('unrelate requires --reason (the removal is logged durably into the record)');
  }

  const store = new MemspecStore(options.cwd);

  const from = store.findById(options.from);
  if (!from) throw new Error(`Memory not found: ${options.from}`);

  const overrideOperator = options.overrideOperator ?? false;
  if (effectiveSourceKind(from) === 'operator' && !overrideOperator) {
    throw new Error(
      `"${from.id}" is operator-sourced (source: ${from.source}). ` +
      'Removing an edge from operator knowledge requires override_operator: true; use it only with explicit cause.',
    );
  }

  const existing = readEdges(from, type);
  const present = existing.includes(options.to);

  if (!present) {
    return {
      from_id: from.id,
      to_id: options.to,
      type,
      removed: false,
      total_edges_of_type: existing.length,
      message: `No ${type} edge ${from.id} -[${type}]-> ${options.to} to remove (no-op)`,
    };
  }

  const next = existing.filter((id) => id !== options.to);
  const updated = writeEdges(from, type, next);

  // Drop the provenance mark alongside the conflict edge it described.
  if (type === 'conflicts_with') {
    updated.ext = unmarkEdgeSource(updated, options.to);
  }

  // Audit log: append a removal record. Override use is folded into the reason,
  // mirroring supersede, so the persisted trail names it explicitly.
  const reason = effectiveSourceKind(from) === 'operator' && overrideOperator
    ? `${options.reason} [override_operator used on operator-sourced record]`
    : options.reason;
  const removalLog = Array.isArray(updated.ext?.edge_removals)
    ? [...(updated.ext!.edge_removals as unknown[])]
    : [];
  removalLog.push({
    type,
    to: options.to,
    removed_at: new Date().toISOString(),
    removed_by: options.source ?? 'unknown',
    reason,
  });
  updated.ext = { ...(updated.ext ?? {}), edge_removals: removalLog };

  store.updateItem(updated);

  return {
    from_id: from.id,
    to_id: options.to,
    type,
    removed: true,
    total_edges_of_type: next.length,
    message: `Removed ${from.id} -[${type}]-> ${options.to} (now ${next.length} ${type} edge(s))\nReason: ${reason}`,
  };
}
