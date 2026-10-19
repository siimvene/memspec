import { z } from 'zod';
import { effectiveSourceKind } from '../lib/source.js';
import { CompositeStore } from '../lib/composite-store.js';
import { MemspecStore } from '../lib/store.js';
import type { MemoryItem } from '../lib/types.js';

/**
 * Resolve the store to mutate `id` in, refusing a record that lives in a
 * read-only layer (C2). Shared by relate/unrelate: both write to the `from`
 * record. Falls back to a plain store when no layer owns the id, so the
 * caller's own not-found error still fires with its original message.
 */
function writableStoreFor(cwd: string | undefined, id: string): { store: MemspecStore; view: CompositeStore } {
  const composite = CompositeStore.forCwd(cwd);
  const owner = composite.assertWritableLayerForId(id);
  return { store: owner ? owner.store : new MemspecStore(cwd), view: composite };
}

/**
 * v0.4: typed edge kinds writable via `memspec_relate`. Mirrors the
 * MemoryFrontmatter relation fields exactly; keep in sync.
 * v0.13 adds `distinct_from` ("compared, independent"), which acknowledges an
 * overlap for `memspec check` but is not a retrieval edge.
 */
export const RELATION_TYPES = ['refines', 'supports', 'depends_on', 'derived_from', 'conflicts_with', 'distinct_from'] as const;
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

/**
 * Claim edges live on claims. A question group relates to its answers through
 * `answers:` (managed by `memspec question --add`), never through
 * refines/supports/depends_on/derived_from/conflicts_with/distinct_from — the other in-place
 * mutators (anchor, verify, supersede) already refuse non-active records, and
 * a question is never `active`.
 */
function assertNotQuestion(from: MemoryItem, verb: 'relate' | 'unrelate'): void {
  if (from.kind === 'question') {
    throw new Error(
      `${verb} refuses a question record as --from (${from.id}): question groups carry answers, not claim edges. ` +
        `Use \`memspec question ${from.id} --add <id>\` to change its answers.`,
    );
  }
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

  const { store, view } = writableStoreFor(options.cwd, options.from);

  const from = store.findById(options.from);
  if (!from) throw new Error(`Memory not found: ${options.from}`);
  assertNotQuestion(from, 'relate');

  // The edge is written onto `from` only, so the target may live in ANY layer
  // of the read view (a read-only team record included) — the same rule
  // `remember --supports/--refines` applies at creation time.
  const to = store.findById(options.to) ?? view.findById(options.to);
  if (!to) throw new Error(`Memory not found: ${options.to}`);

  // A record must not both conflict with and positively relate to the same
  // target (S2a): that contradiction is exactly what let overlap-repair strand
  // a deliberately-asserted conflict. Refuse before writing, both directions.
  const POSITIVE_TYPES: RelationType[] = ['refines', 'supports', 'depends_on', 'derived_from'];
  // v0.13 — `distinct_from` says "compared, and they are independent", which
  // contradicts every other relationship between the two records. Refused
  // whichever record carries either edge (from→to and to→from).
  const distinctClash = distinctFromExclusion(from, to, type);
  if (distinctClash) throw new Error(`relate refuses ${distinctClash}`);
  if (type === 'distinct_from') {
    // Fully covered by distinctFromExclusion.
  } else if (type === 'conflicts_with') {
    const positiveHit = POSITIVE_TYPES.find((t) => readEdges(from, t).includes(options.to));
    if (positiveHit) {
      throw new Error(
        `relate refuses conflicts_with → ${options.to}: ${options.from} already declares a positive edge (${positiveHit}) to that target. ` +
          `Declare one relationship, not both — remove the ${positiveHit} edge first if the conflict is correct.`,
      );
    }
  } else if (readEdges(from, 'conflicts_with').includes(options.to)) {
    throw new Error(
      `relate refuses ${type} → ${options.to}: ${options.from} already declares conflicts_with that target. ` +
        `Declare one relationship, not both — remove the conflict edge first (memspec unrelate) if the ${type} is correct.`,
    );
  }

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

/** The edge lists a record can carry to another record, `supersedes` included. */
type EdgeHolder = Pick<MemoryItem, 'id' | 'refines' | 'supports' | 'depends_on' | 'derived_from' | 'conflicts_with' | 'distinct_from' | 'supersedes'>;

function edgeTypesTo(holder: EdgeHolder, targetId: string): Array<RelationType | 'supersedes'> {
  const hits: Array<RelationType | 'supersedes'> = RELATION_TYPES.filter((t) => readEdges(holder as MemoryItem, t).includes(targetId));
  if ((holder.supersedes ?? []).includes(targetId)) hits.push('supersedes');
  return hits;
}

/**
 * v0.13 — `distinct_from` ("compared, independent") contradicts every other
 * relationship between the same two records, whichever record carries it.
 * Returns the refusal (without the verb) when adding a `type` edge from
 * `from` to `to` would put distinct_from and another edge between them, in
 * either direction; null when the edge is allowed. Shared by `relate` and
 * `remember`.
 */
export function distinctFromExclusion(from: EdgeHolder, to: EdgeHolder, type: RelationType): string | null {
  if (type === 'distinct_from') {
    const forward = edgeTypesTo(from, to.id).find((t) => t !== 'distinct_from');
    if (forward) {
      return (
        `distinct_from → ${to.id}: ${from.id} already declares ${forward} to that target. ` +
        `distinct_from means the records are independent; remove the ${forward} edge first (memspec unrelate) if that is correct.`
      );
    }
    const reverse = edgeTypesTo(to, from.id).find((t) => t !== 'distinct_from');
    if (reverse) {
      return (
        `distinct_from → ${to.id}: ${to.id} already declares ${reverse} to ${from.id}. ` +
        `distinct_from means the records are independent; remove that ${reverse} edge first (memspec unrelate) if that is correct.`
      );
    }
    return null;
  }
  if ((from.distinct_from ?? []).includes(to.id)) {
    return (
      `${type} → ${to.id}: ${from.id} already declares distinct_from that target (compared, independent). ` +
      `Declare one relationship, not both — remove the distinct_from edge first (memspec unrelate) if the ${type} is correct.`
    );
  }
  if ((to.distinct_from ?? []).includes(from.id)) {
    return (
      `${type} → ${to.id}: ${to.id} already declares distinct_from ${from.id} (compared, independent). ` +
      `Declare one relationship, not both — remove that distinct_from edge first (memspec unrelate) if the ${type} is correct.`
    );
  }
  return null;
}

function readEdges(item: MemoryItem, type: RelationType): string[] {
  switch (type) {
    case 'refines': return item.refines ?? [];
    case 'supports': return item.supports ?? [];
    case 'depends_on': return item.depends_on ?? [];
    case 'derived_from': return item.derived_from ?? [];
    case 'conflicts_with': return item.conflicts_with ?? [];
    case 'distinct_from': return item.distinct_from ?? [];
  }
}

function writeEdges(item: MemoryItem, type: RelationType, edges: string[]): MemoryItem {
  switch (type) {
    case 'refines': return { ...item, refines: edges };
    case 'supports': return { ...item, supports: edges };
    case 'depends_on': return { ...item, depends_on: edges };
    case 'derived_from': return { ...item, derived_from: edges };
    case 'conflicts_with': return { ...item, conflicts_with: edges };
    case 'distinct_from': return { ...item, distinct_from: edges };
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
  /** Required to remove an edge from an operator-sourced record. Honoured only on the CLI channel. */
  overrideOperator?: boolean;
  /**
   * Which surface invoked this (S5). `mcp` callers can never override operator
   * protection — an autonomous agent self-authorizing to edit operator memory
   * is not a real gate. The MCP tool omits the override parameter entirely and
   * always sets this to `mcp`, so operator records refuse regardless of flags.
   */
  channel?: 'cli' | 'mcp';
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

  const { store } = writableStoreFor(options.cwd, options.from);

  const from = store.findById(options.from);
  if (!from) throw new Error(`Memory not found: ${options.from}`);
  assertNotQuestion(from, 'unrelate');

  const viaMcp = options.channel === 'mcp';
  // MCP can never override; the override flag is honoured only on the CLI.
  const overrideOperator = !viaMcp && (options.overrideOperator ?? false);
  if (effectiveSourceKind(from) === 'operator' && !overrideOperator) {
    throw new Error(
      viaMcp
        ? `"${from.id}" is operator-sourced (source: ${from.source}). ` +
            'Removing an edge from operator memory is not available over MCP; run `memspec unrelate --override-operator` from a terminal, where a human is present to authorize it.'
        : `"${from.id}" is operator-sourced (source: ${from.source}). ` +
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
