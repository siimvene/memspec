export const MEMORY_KINDS = ['claim', 'observation'] as const;
export type MemoryKind = typeof MEMORY_KINDS[number];

export const MEMORY_TYPES = ['fact', 'decision', 'procedure'] as const;
export type MemoryType = typeof MEMORY_TYPES[number];

/**
 * v0.3 lifecycle states. Earlier records used `captured | corrected | decayed | archived` —
 * the reader collapses those into the new enum: captured → active, corrected → superseded,
 * decayed → retired, archived → retired.
 */
export const LIFECYCLE_STATES = ['active', 'superseded', 'retired'] as const;
export type LifecycleState = typeof LIFECYCLE_STATES[number];

/** States produced by pre-0.3 writers, accepted on read and mapped to LIFECYCLE_STATES. */
export const LEGACY_LIFECYCLE_STATES = ['captured', 'corrected', 'decayed', 'archived'] as const;
export type LegacyLifecycleState = typeof LEGACY_LIFECYCLE_STATES[number];

export const SOURCE_KINDS = ['operator', 'agent', 'import'] as const;
export type SourceKind = typeof SOURCE_KINDS[number];

/**
 * How the claim was last witnessed. Replaces confidence in v0.3 — the reader infers
 * the strongest available witness when the field is absent on legacy records.
 *
 * Strength order (descending): anchor > probe > operator > evidence > assertion.
 * `probe` is a mechanical witness like `anchor`: a stored command whose output
 * hash is re-checked on demand (never on read — probes execute shell commands).
 */
export const VERIFIED_WITH = ['anchor', 'probe', 'operator', 'evidence', 'assertion'] as const;
export type VerifiedWith = typeof VERIFIED_WITH[number];

export interface MemoryFrontmatter {
  id: string;
  kind: MemoryKind; // 'claim' for fact/decision/procedure; 'observation' for point-in-time notes
  type?: MemoryType; // claims only — observations have no type
  state: LifecycleState;
  created: string;
  source: string;
  source_kind?: SourceKind; // trust tier inferred from source at write time
  tags: string[];
  /**
   * Read-side partition. Absent = visible from every scope (the pre-scoping
   * default); `universal` = explicitly visible everywhere; any other name =
   * visible only when that scope is active. Single-valued by design — a record
   * belongs to one project or to everyone.
   */
  scope?: string;
  check_by: string; // ISO 8601 or "never" — renamed from decay_after; flag-only, never deletes
  stale?: boolean; // set when check_by passes; cleared by verify; removal only via sweep
  last_verified?: string; // ISO 8601 — when this memory was last confirmed true (defaults to created)
  verified_with?: VerifiedWith; // how it was last witnessed
  pinned?: boolean; // operator-only; always surfaced in boot context
  anchors?: CodeAnchor[]; // promoted from ext.code_anchors in v0.3 — schema spine
  probe?: ProbeWitness; // a shell command + output hash; re-run only on explicit `probe`/`verify` to detect drift
  supersedes?: string[]; // ids this record replaces (renamed from corrects; now array)
  superseded_by?: string; // id of the record that replaced this one (renamed from corrected_by)
  supersede_reason?: string; // durable reason — renamed from correction_reason
  conflicts_with?: string[]; // explicit conflict edges to other memory ids
  refines?: string[]; // ids this record refines/elaborates on (parent stays valid)
  supports?: string[]; // ids this record provides evidence for
  depends_on?: string[]; // ids this record presupposes (knowledge or chronological dependency)
  expires?: string; // observations only — hard expiry (ISO 8601)
  /** ISO 8601. World-state truth becomes valid at this point. Open-ended if absent. */
  valid_from?: string;
  /** ISO 8601. World-state truth ceases to hold at this point. Open-ended if absent. */
  valid_to?: string;
  /**
   * Recommended ext field conventions:
   * - ext.confirmations: number — times this memory has been independently confirmed
   * - ext.confirmed_by: string[] — sources that confirmed this memory
   * - ext.promoted_at: string — ISO 8601 timestamp of promotion to active
   * - ext.code_anchors: CodeAnchor[] — DEPRECATED in v0.3; reader migrates to top-level `anchors`
   * - ext.last_verification: { at: string, source?: string, evidence?: string } — most recent verify call
   * - ext.legacy_confidence: number — pre-0.3 confidence float, kept for archaeology only
   * - ext.edge_sources: Record<targetId, "asserted"> — v0.10 provenance for conflicts_with edges.
   *   Marks an edge a caller deliberately wired (via relate or `remember --conflicts-with`) rather
   *   than one the removed lexical auto-attach inferred; the drain script keeps asserted, drops the rest.
   * - ext.edge_removals: Array<{ type, to, removed_at, removed_by, reason }> — v0.10 audit log of edges
   *   dropped via `unrelate`, so a retraction is itself traceable.
   */
  ext?: Record<string, unknown>;
}

/**
 * A code anchor links a memory to the state of a file it depends on.
 * `sha` is the git blob SHA of the file content (as computed by `git hash-object`)
 * at the time the anchor was set or last verified. Tools that understand anchors
 * (verify, reconcile, decay) compare the recorded SHA against the current file
 * content to detect drift. Tools that don't understand anchors ignore them.
 */
export interface CodeAnchor {
  file: string; // path relative to the project root (POSIX separators)
  sha: string;  // git blob SHA of file content at anchor time
  repo?: string; // when set, `file` lives in another repo checked out next to this project (or under a configured search path)
}

/**
 * A probe links a memory to the output of a shell command instead of to a
 * file's blob SHA. `hash` is the sha256 of the command's stdout when the probe
 * was last baselined; a re-run whose stdout hashes differently marks the record
 * drifted. Probes execute shell commands, so they are re-run ONLY on explicit
 * invocation (`memspec probe`, `memspec verify`) — never on a read path.
 */
export interface ProbeWitness {
  cmd: string;  // shell command executed from the project root
  hash: string; // sha256 (hex) of the command's stdout at baseline time
}

export interface MemoryItem extends MemoryFrontmatter {
  title: string;
  body: string;
  filePath: string;
  /**
   * Read-time annotation stamped by `CompositeStore` when a record is served
   * from a NON-primary store layer, naming that layer (e.g. a read-only team
   * store). Absent on records from the primary/writable layer and on every
   * single-store (non-layered) read, so retrieval stays byte-identical there.
   * Never persisted: `serializeMemoryFile` whitelists frontmatter fields and
   * does not include this one.
   */
  layer?: string;
}

export const DEFAULT_DECAY_DAYS: Record<MemoryType, number> = {
  fact: 90,
  decision: 180,
  procedure: 90,
};

export const DEFAULT_OBSERVATION_TTL_DAYS = 7;
