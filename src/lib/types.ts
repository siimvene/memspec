export const MEMORY_KINDS = ['claim', 'observation', 'question'] as const;
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

/**
 * v0.11 question-group states. A question is `open` while its answer is
 * undecided and `resolved` once one answer has been settled on. Distinct from
 * the claim/observation lifecycle — a question never goes stale or retires.
 */
export const QUESTION_STATES = ['open', 'resolved'] as const;
export type QuestionState = typeof QUESTION_STATES[number];

/** Every state string the `state` field may carry, across all kinds. */
export const ALL_STATES = [...LIFECYCLE_STATES, ...QUESTION_STATES] as const;
export type RecordState = LifecycleState | QuestionState;

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
  state: RecordState;
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
  derived_from?: string[]; // v0.11 — ids this record was inferred FROM, not observed directly
  /**
   * v0.13 — ids the writer COMPARED this record with and judged independent:
   * neither contradicts, refines, supports nor depends on the other. Not a
   * retrieval edge (search expansion and lineage never follow it); it exists
   * so `memspec check` can tell an examined overlap from an unexamined one.
   * Mutually exclusive with every other edge between the same two records, whichever record carries it.
   */
  distinct_from?: string[];
  /**
   * v0.11 — procedures only. Step labels or short phrases a HUMAN must perform;
   * an unattended runner refuses these steps. Schema-rejected on non-procedures.
   */
  requires_human?: string[];
  /**
   * v0.11 — committed evidence layer (Layer B). Each entry is either a
   * content-addressed local file copied under `<store>/evidence/` (carries
   * sha256/name/path/source) or an http(s) URL recorded without fetching
   * (carries url). A file-backed entry witnesses the claim as `evidence`.
   */
  evidence?: EvidenceEntry[];
  /** v0.11 — questions only. Competing answer record ids for this question. */
  answers?: string[];
  /** v0.11 — questions only. True = the listed answers are the only candidates (closed world). */
  closed?: boolean;
  /** v0.11 — questions only. Set to the surviving answer id when state is `resolved`. */
  resolved_by?: string;
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
   * - ext.anchor_history: Array<{ at, source?, evidence?, evidence_file?, anchors: Array<{ file, repo?, previous_sha, sha }> }> —
   *   one entry per `verify --reanchor` that re-baselined changed anchors; the old shas are kept, never overwritten.
   * - ext.rejected_value_overrides: Array<{ id, reason, superseded_by?, similarity, overridden_at, overridden_by }> —
   *   written by `remember --allow-rejected` (CLI only): the archived records whose rejected value this record re-asserts.
   * - ext.supersede_kind: 'replace' | 'merge' | 'retract' — stamped by `supersede` on each record it archives. `remember`'s
   *   tombstone refuses a replaced or retracted value; a merged-away record is consolidation, judged against its survivor.
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

/**
 * v0.11 — a committed evidence attachment (Layer B). Two shapes:
 * - file-backed: `sha256` (hex), `name` (basename), `path` (relative to the
 *   store root, under `evidence/`), `source` (where it was copied from:
 *   `~`-relative, `repo:path`, or omitted — never an absolute path). Copied
 *   into `<store>/evidence/<sha256[:12]>/<name>`, content-addressed.
 * - url-backed: `url` (http/https), never fetched — recorded as a pointer.
 * Both carry `captured_at` (ISO 8601). A file-backed entry witnesses a claim
 * as `verified_with: evidence` when the record has no anchors.
 */
export interface EvidenceEntry {
  sha256?: string;
  name?: string;
  path?: string;
  source?: string;
  url?: string;
  captured_at: string;
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
  /**
   * Read-time annotation stamped by `CompositeStore.loadAll` on a record that
   * lives in a READ-ONLY layer and is superseded, in this read view, by an
   * active record in a writable layer (one declaring `supersedes: [<this id>]`).
   * Such a record is served with `state: 'superseded'` and `superseded_by`
   * pointing at the local record, and is left out of `loadActive`/`search`.
   * The file in the read-only layer is untouched; the supersession lands there
   * only when the local record is promoted. Never persisted.
   */
  superseded_in_view?: true;
}

export const DEFAULT_DECAY_DAYS: Record<MemoryType, number> = {
  fact: 90,
  decision: 180,
  procedure: 90,
};

export const DEFAULT_OBSERVATION_TTL_DAYS = 7;
