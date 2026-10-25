import { basename, dirname, resolve } from 'node:path';
import { ulid } from 'ulid';
import { projectRootForStore, resolveAnchorForWrite, type AnchorResolveOptions } from '../lib/anchors.js';
import { getDecayDays, loadConfig } from '../lib/config.js';
import {
  matchesConflictInferenceRule,
  normaliseTitle,
  rankByLexicalCloseness,
} from '../lib/inference.js';
import { effectiveSourceKind, inferSourceKind } from '../lib/source.js';
import { assertKnownScope, assertScopeRequired, isVisibleFromScope, resolveScopeForCwd } from '../lib/scope.js';
import { CLAIM_SIMILARITY_THRESHOLD, claimTokens, tokenWeight, weightedSimilarity } from '../lib/similarity.js';
import { loadClaimIndex, type ClaimIndexEntry } from '../lib/claim-index.js';
import { CompositeStore } from '../lib/composite-store.js';
import { attachEvidence, validateEvidenceSource } from '../lib/evidence.js';
import { addAnswers, loadQuestion } from '../lib/questions.js';
import { distinctFromExclusion, type RelationType } from './relate.js';
import { MEMORY_TYPES, type CodeAnchor, type EvidenceEntry, type MemoryItem, type MemoryType, type VerifiedWith } from '../lib/types.js';

export interface RememberOptions {
  cwd?: string;
  body?: string;
  source?: string;
  tags?: string;
  /** ISO timestamp or "never" — renamed from decay_after on the v0.3 surface. */
  checkBy?: string;
  /** File paths to anchor the claim to. Absolute, project-relative, or repo-qualified — see resolveAnchorForWrite. */
  anchors?: string[];
  /**
   * Checkout directory a repo-relative anchor path belongs to, when the file
   * lives outside the store's project root (the common case for a home-rooted
   * personal store). Recorded as a cross-repo `repo` anchor.
   */
  anchorRoot?: string;
  store?: string;
  /**
   * Directory the target store is resolved from, when it differs from `cwd`.
   * `--store global` sets this to the home directory: it changes WHERE THE
   * RECORD IS WRITTEN, not where the agent is working, so `cwd` must keep
   * pointing at the project for scope derivation to stay correct.
   */
  storeRoot?: string;
  /** Operator-only (CLI flag, deliberately absent from the MCP surface): always surface in boot context. */
  pin?: boolean;
  /** v0.4 typed relations — ids this record refines/supports/depends-on (forms a typed edge to each target). */
  refines?: string[];
  supports?: string[];
  dependsOn?: string[];
  /** v0.11 — ids this record was inferred FROM (positive edge; a record with any is `derived`). */
  derivedFrom?: string[];
  /**
   * v0.13 — ids the writer compared this record with and judged independent
   * (acknowledges an overlap for `memspec check`; not a retrieval edge).
   */
  distinctFrom?: string[];
  /** v0.11 — procedures only: step labels/phrases a human must perform. Rejected on non-procedures. */
  requiresHuman?: string[];
  /** v0.11 — evidence attachments: local file paths (copied under evidence/) or http(s) URLs (recorded, not fetched). */
  evidence?: string[];
  /** v0.11 — add the freshly-written record as an answer to this question id in the same call. */
  answersQuestion?: string;
  /**
   * v0.10 — ids this record explicitly CONFLICTS WITH. Caller-asserted, unlike
   * the removed mid-band auto-attach: each target is validated to exist and
   * marked `ext.edge_sources[target] = "asserted"` so future tooling (the
   * drain script) can tell a deliberate conflict from a heuristic one.
   */
  conflictsWith?: string[];
  /** v0.5 Phase 2 — ISO 8601 timestamp at which the world-state truth becomes valid. Orthogonal to check_by. */
  validFrom?: string;
  /** v0.5 Phase 2 — ISO 8601 timestamp at which the world-state truth ceases to hold. Orthogonal to check_by. */
  validTo?: string;
  /**
   * Read-side partition for this record. Overrides the scope derived from
   * `cwd` via the store's `scopes:` config. Pass `universal` to classify the
   * record as visible everywhere; omit both and no `scope` field is written.
   */
  scope?: string;
  /**
   * Write even though the claim near-matches a value that was superseded or
   * retracted (the tombstone refusal). Honoured only on the CLI channel; the
   * override is logged into the new record's `ext.rejected_value_overrides`.
   */
  allowRejected?: boolean;
  /**
   * Which surface invoked this. On `mcp` a tombstone refusal is final:
   * `allowRejected` is ignored, so an agent cannot re-assert a value a
   * supersede rejected by flipping a flag. Same rule as `unrelate`.
   */
  channel?: 'cli' | 'mcp';
}

export interface DuplicateMatch {
  id: string;
  title: string;
  score: number;
}

/**
 * v0.10 — a mid-band neighbour the lexical inference rule matched. Surfaced as
 * a SUGGESTION only: `remember` never writes the edge. The caller decides
 * whether the records genuinely conflict and, if so, wires it via `relate`
 * (or asserts it at write time via `--conflicts-with`). Replaces the removed
 * auto-attach, which stamped `conflicts_with` on records that merely shared a
 * topic (measured 8/8 wrong on real attachments).
 */
export interface SuggestedConflict {
  id: string;
  title: string;
  /** One-line lexical rationale, e.g. "same fact; shared tag(s): cache; 3 title-token overlap". */
  rationale: string;
}

export interface RememberResult {
  id: string;
  filePath: string;
  message: string;
  verified_with: VerifiedWith;
  anchors: CodeAnchor[];
  anchorWarnings: string[];
  duplicates?: DuplicateMatch[];
  /** Lexical conflict candidates for the caller to act on via `relate`; never auto-written. */
  suggestedConflicts?: SuggestedConflict[];
  /** Scope stamped on the record; absent when nothing matched and nothing was passed. */
  scope?: string;
  /** v0.11 — evidence entries attached to the record (file copies + URL pointers). */
  evidence?: EvidenceEntry[];
  /** v0.11 — true when the record carries a derived_from edge. */
  derived?: boolean;
  /** v0.11 — step labels a human must perform (procedures only). */
  requiresHuman?: string[];
  /** v0.11 — the question id this record was added to as an answer, when requested. */
  answeredQuestion?: string;
  /** v0.11 — true when adding this record reopened a previously resolved question. */
  reopenedQuestion?: boolean;
}

/**
 * v0.4 Phase 5 — write-path neighbour walk constants. Kept here (not in
 * inference.ts) because the bands are a `remember` policy choice; the
 * inference helpers themselves are pure predicates.
 */

/**
 * Window of recent active records we score for proximity. Mirrors the
 * "top-N candidates (N=5 default)" requirement in the Phase 5 spec; we
 * fetch a wider pool from the search index so the per-type filter still
 * leaves enough material to rank.
 */
const NEIGHBOUR_CANDIDATE_LIMIT = 5;

/**
 * High band: exact normalised title match against an existing same-type
 * record. The v0.3 changelog promises `remember` "refuses near-duplicates";
 * an identical title within the same type is the strongest signal we can
 * detect lexically without crossing into semantic territory. Hits raise
 * an error and point at `supersede`.
 */
function isHighBand(existingTitle: string, incomingTitle: string): boolean {
  return normaliseTitle(existingTitle) === normaliseTitle(incomingTitle);
}

/** An archived record whose value the incoming claim re-asserts (tombstone hit). */
interface RejectedValueMatch {
  id: string;
  reason: string;
  /** Direct `superseded_by`; absent for a retraction. */
  supersededBy?: string;
  /** The live end of the `superseded_by` chain, when one is still active. */
  survivor?: string;
  similarity: number;
}

/** Follow `superseded_by` from an archived record to the active record that now holds its place, if any. */
function activeSurvivor(item: ClaimIndexEntry, byId: Map<string, ClaimIndexEntry>): ClaimIndexEntry | undefined {
  const seen = new Set<string>();
  let cur: ClaimIndexEntry | undefined = item;
  while (cur && cur.state !== 'active' && cur.superseded_by && !seen.has(cur.id)) {
    seen.add(cur.id);
    cur = byId.get(cur.superseded_by);
  }
  return cur && cur.state === 'active' ? cur : undefined;
}

function describeRejection(m: RejectedValueMatch): string {
  const fate = m.supersededBy === undefined
    ? 'retracted with no replacement'
    : m.survivor === undefined
      ? `superseded by ${m.supersededBy} (no longer active)`
      : m.survivor === m.supersededBy
        ? `superseded by ${m.supersededBy}`
        : `superseded by ${m.supersededBy} (now ${m.survivor})`;
  return `this value was rejected in ${m.id} (reason: ${m.reason}), ${fate}`;
}

function assertMemoryType(input: string): MemoryType {
  if ((MEMORY_TYPES as readonly string[]).includes(input)) {
    return input as MemoryType;
  }
  throw new Error(`Unsupported memory type: ${input}`);
}

function toCheckBy(decayDays: number, override?: string, now: Date = new Date()): string {
  if (override === 'never') return 'never';
  if (override) return override;

  const expires = new Date(now);
  expires.setUTCDate(expires.getUTCDate() + decayDays);
  return expires.toISOString();
}

function parseTags(raw?: string): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

/**
 * Resolve inline anchor paths to {repo?, file, sha} records at write time.
 * Absolute paths, project-relative paths, and repo-qualified / anchor-root
 * paths are all accepted (see resolveAnchorForWrite). Paths that resolve
 * nowhere produce an actionable warning rather than failing the write — the
 * claim still records, and the caller is told to pass an absolute path or
 * anchor_root.
 */
function resolveAnchors(
  projectRoot: string,
  files: string[],
  options: AnchorResolveOptions,
): { anchors: CodeAnchor[]; warnings: string[] } {
  const anchors: CodeAnchor[] = [];
  const warnings: string[] = [];

  for (const file of files) {
    const result = resolveAnchorForWrite(projectRoot, file, options);
    if ('error' in result) {
      warnings.push(result.error);
      continue;
    }
    const { anchor } = result;
    if (result.warning) warnings.push(result.warning);
    if (!anchors.some((a) => a.file === anchor.file && a.repo === anchor.repo)) {
      anchors.push(anchor);
    }
  }

  return { anchors, warnings };
}

/**
 * v0.3 entry point for new claims. Renamed from `add`; adds inline anchors so
 * code-state claims can be anchored in the same call that creates them.
 */
export function runRemember(typeInput: string, title: string, options: RememberOptions): RememberResult {
  const type = assertMemoryType(typeInput);

  // S1 — actuation boundary. requires_human is a procedure-only field; refuse
  // it early with a friendly message rather than letting the schema reject the
  // written frontmatter after the fact.
  if (options.requiresHuman && options.requiresHuman.length > 0 && type !== 'procedure') {
    throw new Error(`--requires-human is only valid on a procedure (got ${type})`);
  }

  const source = options.source?.trim();
  if (!source || source.toLowerCase() === 'unknown') {
    throw new Error(
      'source is required and may not be "unknown" — pass --source <who-is-writing> (e.g. --source human:siim, --source claude-code)',
    );
  }

  // Pointer-file repos (no local .memspec) declare their layers explicitly.
  // Writes must name a target when more than one writable layer is in scope —
  // a silently-guessed store is how team knowledge leaks into the personal
  // store and vice versa.
  // Store selection reads `storeRoot` when the caller named a store that lives
  // outside the project (`--store global`); everything downstream of the write
  // target follows it. `options.cwd` is deliberately left alone — see the
  // scope derivation below.
  const storeSelectionCwd = options.storeRoot ?? options.cwd;
  // `CompositeStore.resolveWritable` applies one rule to a `.memspec.yaml`
  // pointer, a walked-up store's own `stores:` block, and the unlayered case:
  // `--store <name>` must name a declared layer (unknown → error listing the
  // layers; `writable: false` → refused by name), and with no name exactly one
  // writable layer must be in scope. Previously only the pointer branch looked
  // at `--store`, so `--store team` on a layered personal store wrote to the
  // personal store and exited 0 (#11).
  // `--store global` is the legacy "write to ~/.memspec" spelling: the CLI/MCP
  // already pointed storeRoot at the home directory, so when that store
  // declares no layer literally named `global`, the name is dropped and the
  // home store's own writable layer receives the write.
  // Both defaults live in `resolveWritableWithDefaults` so `observe` applies
  // the identical rule.
  const resolvedWrite = CompositeStore.resolveWritableWithDefaults(storeSelectionCwd, options.store, options.storeRoot !== undefined);
  const store = resolvedWrite.layer.store;
  store.init();

  const config = loadConfig(store.root);
  const decayDays = getDecayDays(config, type);

  const tags = parseTags(options.tags);
  const incomingSourceKind = inferSourceKind(source);

  // Scope derivation reads the WORKING directory, not the resolved store path:
  // a pointer file (or `--store global`) can send the write to a store that
  // lives somewhere else entirely, but the record still belongs to the project
  // being worked on. Routing the write to the global store and thereby
  // stamping no scope is exactly how cross-project knowledge arrives
  // unclassified and pollutes every other project's retrieval.
  // No explicit value and no matching pattern means no `scope` field at all —
  // absent and `universal` are different classifications, not synonyms.
  const scope = options.scope !== undefined
    ? assertKnownScope(config.scopes, options.scope)
    : resolveScopeForCwd(config.scopes, resolve(options.cwd ?? process.cwd()));

  // F2 — scope enforcement. A store opted into `scopes_require: true` refuses
  // an unscoped write outright rather than letting it land visible from
  // nowhere in particular. `--scope universal` is the explicit opt-out.
  assertScopeRequired(config.scopes_require, scope, config.scopes, () => store.scopesInUse());

  // Phase 5 — neighbour walk over same-type active records.
  // `store.search` is BM25-ranked and unbounded; we use it as a candidate
  // funnel and apply the (deterministic, explainable) lexical predicates
  // from inference.ts to decide refusal vs. auto-attach.
  let duplicates: DuplicateMatch[] | undefined;
  let suggestedConflicts: SuggestedConflict[] | undefined;
  const viaMcp = options.channel === 'mcp';
  // MCP can never override a tombstone; the flag is honoured only on the CLI.
  const allowRejected = !viaMcp && (options.allowRejected ?? false);
  const rejectedValues: RejectedValueMatch[] = [];
  try {
    // Scoped so a same-titled record in another project isn't treated as a
    // duplicate of this one. Unscoped and universal records stay visible.
    // Widen the window by the caller's declared targets: they are excluded
    // from inference below, so without this a declared parent at rank 1 could
    // push a genuine conflict out of the candidate window entirely.
    // Caller-asserted conflicts_with targets count as declared too (M2): they
    // are excluded from suggestions below, so widen the window by their count
    // as well or a genuine different conflict could be pushed out of it.
    const declaredCount = (options.refines?.length ?? 0) + (options.supports?.length ?? 0) + (options.dependsOn?.length ?? 0) + (options.derivedFrom?.length ?? 0) + (options.conflictsWith?.length ?? 0) + (options.distinctFrom?.length ?? 0);
    const candidates = store.search(title, { types: [type], limit: NEIGHBOUR_CANDIDATE_LIMIT + declaredCount, scope });

    // High band — exact-title refusal. The v0.3 dedup-refusal promise lives
    // here. Surfaces every same-type record that normalises to the same title.
    const exactMatches = candidates.filter((item) => isHighBand(item.title, title));
    if (exactMatches.length > 0) {
      const survivorList = exactMatches.map((m) => `${m.id} "${m.title}"`).join(', ');
      throw new Error(
        `remember refuses near-duplicate: an active ${type} with the same title already exists (${survivorList}). ` +
          `Use \`memspec supersede\` to replace, merge, or retract it instead of writing a twin.`,
      );
    }

    // A caller who passed an explicit positive edge (refines / supports /
    // depends_on) to a neighbour has already classified that relationship.
    // The similarity heuristic must not overrule it by stamping a
    // `conflicts_with` onto the same target — and high title similarity to a
    // parent is the expected signature of a legitimate refines, so the
    // heuristic fires hardest exactly where it is most likely to be wrong.
    // Drop caller-declared targets before choosing the closest neighbour, so
    // the inference is skipped for them but can still fire on a genuinely
    // unrelated one. See fact ms_01KZJXHBZT6YXY9P500JFCE4SX.
    // The same set is exempt from the near-duplicate refusal below: a refines
    // child restates its parent by design, and distinct_from is how a caller
    // records that a lexically close record is a different claim.
    const callerDeclared = new Set<string>([
      ...(options.refines ?? []),
      ...(options.supports ?? []),
      ...(options.dependsOn ?? []),
      ...(options.derivedFrom ?? []),
      // A target the caller is asserting a conflict with is already classified;
      // re-suggesting it as a conflict is noise (M2).
      ...(options.conflictsWith ?? []),
      // v0.13 — "compared, independent" is a classification too.
      ...(options.distinctFrom ?? []),
    ]);

    // Near-duplicate band — the same claim under a different title. Title +
    // body similarity (lib/similarity.ts) against EVERY same-type record
    // visible from this scope, not just the BM25 window above: a paraphrase
    // ranks poorly on a title query by construction. Records come from the
    // mtime-keyed claim index (lib/claim-index.ts), not a second full parse.
    const all = loadClaimIndex(store);
    const incoming = claimTokens(title, options.body ?? '');
    const incomingWeight = tokenWeight(incoming);
    const comparable = all.filter((item) =>
      item.kind === 'claim' && item.type === type && isVisibleFromScope(item.scope, scope),
    );
    const similarityTo = (item: ClaimIndexEntry): number =>
      weightedSimilarity(incoming, incomingWeight, item.tokens, item.weight, CLAIM_SIMILARITY_THRESHOLD);
    const nearMatches = comparable
      .filter((item) => item.state === 'active' && !callerDeclared.has(item.id))
      .map((item) => ({ item, similarity: similarityTo(item) }))
      .filter((m) => m.similarity >= CLAIM_SIMILARITY_THRESHOLD)
      .sort((a, b) => b.similarity - a.similarity);
    if (nearMatches.length > 0) {
      const survivorList = nearMatches
        .map((m) => `${m.item.id} "${m.item.title}" (similarity ${m.similarity.toFixed(2)})`)
        .join(', ');
      throw new Error(
        `remember refuses near-duplicate: an active ${type} making the same claim already exists (${survivorList}). ` +
          `Use \`memspec supersede\` to replace, merge, or retract it instead of writing a twin. ` +
          `If you compared them and this is a different claim, declare it with distinct_from (--distinct-from <id>).`,
      );
    }

    // Tombstone — a value that a supersede or retraction rejected must not
    // come back through a fresh remember. Derived from the archive records
    // themselves (the claim index only caches them by mtime). An archived record counts
    // only while its live successor says something else: when the incoming
    // claim also matches the survivor, the old value was rewritten rather
    // than rejected (a merge, a wording fix), and the near-duplicate band
    // above already pointed the caller at that survivor. Declared edges do
    // not exempt an archived record: over MCP this refusal is final, and a
    // distinct_from to the rejected id must not become the way around it.
    const byId = new Map(all.map((item) => [item.id, item]));
    for (const old of comparable) {
      if (old.state !== 'superseded') continue;
      const similarity = similarityTo(old);
      if (similarity < CLAIM_SIMILARITY_THRESHOLD) continue;
      const survivor = activeSurvivor(old, byId);
      if (survivor && similarityTo(survivor) >= CLAIM_SIMILARITY_THRESHOLD) continue;
      rejectedValues.push({
        id: old.id,
        reason: old.supersede_reason ?? '(no reason recorded)',
        supersededBy: old.superseded_by,
        survivor: survivor?.id,
        similarity,
      });
    }
    rejectedValues.sort((a, b) => b.similarity - a.similarity);
    if (rejectedValues.length > 0 && !allowRejected) {
      const detail = rejectedValues.map(describeRejection).join('; ');
      throw new Error(
        `remember refuses rejected value: ${detail}. ` +
          (viaMcp
            ? 'This refusal is final over MCP. If new evidence shows the rejection was wrong, supersede the record that replaced it, or have a human run `memspec remember ... --allow-rejected` at a terminal.'
            : 'If new evidence shows the rejection was wrong, supersede the record that replaced it, or pass --allow-rejected to write it anyway (the override is logged into the new record).'),
      );
    }

    // Mid band — apply the lexical conflict-inference rule, but only SUGGEST
    // the matches. The rule is purely lexical (same type, one shared tag, two
    // shared title tokens) and stamps conflicts on records that merely discuss
    // the same topic, so an auto-written edge is wrong far more often than
    // right. The caller acts on the suggestions via `relate` / `--conflicts-with`.
    // Agent writers are not offered operator-tier candidates: nudging an agent
    // to wire a conflict onto operator memory is the same overreach the old
    // auto-attach committed, minus the silence.
    const writerIsAgent = incomingSourceKind === 'agent';
    const ruleMatches = candidates.filter((item) =>
      !callerDeclared.has(item.id) &&
      !(writerIsAgent && effectiveSourceKind(item) === 'operator') &&
      item.type !== undefined && matchesConflictInferenceRule(type, title, tags, item.type, item.title, item.tags),
    );

    if (ruleMatches.length > 0) {
      const ranked = rankByLexicalCloseness(title, tags, ruleMatches);
      const tagSet = new Set(tags);
      suggestedConflicts = ranked.map(({ item, tokenOverlap }) => {
        const sharedTags = item.tags.filter((t) => tagSet.has(t));
        return {
          id: item.id,
          title: item.title,
          rationale: `same ${type}; shared tag(s): ${sharedTags.join(', ')}; ${tokenOverlap} title-token overlap`,
        };
      });
      // Surface the same candidates as the "potential duplicates" hint too —
      // high title overlap is often a near-duplicate, a supersede candidate.
      duplicates = ranked.map(({ item }) => ({
        id: item.id,
        title: item.title,
        score: 1,
      }));
    } else if (candidates.length > 0) {
      // Low-but-noticeable: keep the v0.3 warning surface even when the
      // inference rule didn't fire, so the operator-facing CLI still
      // reports BM25-adjacent hits.
      duplicates = candidates.map((item) => ({
        id: item.id,
        title: item.title,
        score: 1,
      }));
    }
  } catch (err) {
    // Refusal is the one error we want to propagate — everything else
    // (search index hiccup, missing fts.db, etc.) must not block the write.
    if (err instanceof Error && err.message.startsWith('remember refuses')) {
      throw err;
    }
  }

  const anchorFiles = options.anchors ?? [];
  const anchorResolution = anchorFiles.length > 0
    ? resolveAnchors(projectRootForStore(store.root), anchorFiles, {
        anchorRoot: options.anchorRoot,
        repoSearchPaths: config.anchors?.repo_search_paths,
      })
    : { anchors: [] as CodeAnchor[], warnings: [] as string[] };

  // S3 — evidence attachments. VALIDATED here (missing, symlink, over 5 MB,
  // under local/), COPIED only after every other input has passed, right
  // before writeItem — a copy followed by a later refusal (bad valid_from,
  // unknown edge target, missing second evidence path) would orphan a file in
  // the committed evidence/ directory. The validated kind is enough to decide
  // the witness class now.
  const evidenceInputs = options.evidence ?? [];
  const evidenceSources = evidenceInputs.map((item) => validateEvidenceSource(store.root, item));
  const hasFileEvidence = evidenceSources.some((s) => s.kind === 'file');

  // Edge targets are looked up in the write target first, then in the read
  // views of the store-selection cwd and the working cwd: a global record may
  // legitimately relate to a project record that only the project's layered
  // view can see.
  const lookups: Array<{ findById(id: string): MemoryItem | null }> = [store, CompositeStore.forCwd(storeSelectionCwd)];
  if (options.cwd && resolve(options.cwd) !== resolve(storeSelectionCwd ?? process.cwd())) {
    lookups.push(CompositeStore.forCwd(options.cwd));
  }
  const targetExists = (targetId: string): boolean => lookups.some((l) => l.findById(targetId) !== null);

  // Positive edges (refines / supports / depends_on / derived_from) point at
  // records that must exist — a `derived_from: [ms_TYPO]` would mark the record
  // derived, tier its witness down, and dangle in every chain and export.
  // Same rule `relate` and `--conflicts-with` already apply.
  const positiveEdgeInputs: Array<[string, string[] | undefined]> = [
    ['--refines', options.refines],
    ['--supports', options.supports],
    ['--depends-on', options.dependsOn],
    ['--derived-from', options.derivedFrom],
    ['--distinct-from', options.distinctFrom],
  ];
  for (const [flag, ids] of positiveEdgeInputs) {
    for (const targetId of ids ?? []) {
      if (targetId && !targetExists(targetId)) {
        throw new Error(`${flag} target not found: ${targetId}`);
      }
    }
  }

  // v0.11 — the question this record answers must exist and be a question
  // BEFORE the record is written: a bad id used to leave the freshly-written
  // claim on disk while the command reported failure, and the natural retry
  // then hit the near-duplicate refusal.
  const answeredQuestionBefore = options.answersQuestion
    ? loadQuestion(store, options.answersQuestion)
    : undefined;

  // Witness (descending strength anchor > operator > evidence > assertion):
  // anchors resolved → anchor; operator source → operator; file-backed evidence
  // → evidence; else assertion.
  let verifiedWith: VerifiedWith = 'assertion';
  if (anchorResolution.anchors.length > 0) {
    verifiedWith = 'anchor';
  } else if (incomingSourceKind === 'operator') {
    verifiedWith = 'operator';
  } else if (hasFileEvidence) {
    verifiedWith = 'evidence';
  }

  const created = new Date().toISOString();
  const id = `ms_${ulid()}`;

  const itemData: Parameters<typeof store.writeItem>[0] = {
    id,
    kind: 'claim',
    type,
    state: 'active',
    created,
    source,
    source_kind: incomingSourceKind,
    tags,
    check_by: toCheckBy(decayDays, options.checkBy),
    last_verified: created,
    verified_with: verifiedWith,
    title,
    body: options.body ?? '',
  };

  if (scope) {
    itemData.scope = scope;
  }

  if (anchorResolution.anchors.length > 0) {
    itemData.anchors = anchorResolution.anchors;
  }

  if (options.pin) {
    itemData.pinned = true;
  }

  // v0.4 typed relations — dedupe inline so a single call can't write the same
  // edge twice. Empty arrays stay omitted (matches conflicts_with parity).
  const dedupe = (ids: string[] | undefined): string[] | undefined => {
    if (!ids || ids.length === 0) return undefined;
    const seen = new Set<string>();
    const out: string[] = [];
    for (const id of ids) {
      if (id && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
    return out.length > 0 ? out : undefined;
  };

  const refines = dedupe(options.refines);
  if (refines) itemData.refines = refines;
  const supports = dedupe(options.supports);
  if (supports) itemData.supports = supports;
  const dependsOn = dedupe(options.dependsOn);
  if (dependsOn) itemData.depends_on = dependsOn;
  const derivedFrom = dedupe(options.derivedFrom);
  if (derivedFrom) itemData.derived_from = derivedFrom;

  // v0.13 — distinct_from ("compared, independent") contradicts every other
  // relationship to the same target, the same rule `relate` enforces. Refuse
  // a call that declares both instead of writing a self-contradicting record.
  const distinctFrom = dedupe(options.distinctFrom);
  if (distinctFrom) {
    const otherEdges: Array<[string, string[] | undefined]> = [
      ['refines', options.refines],
      ['supports', options.supports],
      ['depends_on', options.dependsOn],
      ['derived_from', options.derivedFrom],
      ['conflicts_with', options.conflictsWith],
    ];
    for (const targetId of distinctFrom) {
      const hit = otherEdges.find(([, ids]) => (ids ?? []).includes(targetId));
      if (hit) {
        throw new Error(
          `--distinct-from ${targetId} contradicts the ${hit[0]} edge to the same target; distinct_from means the records are independent. Declare one relationship, not both.`,
        );
      }
    }
    itemData.distinct_from = distinctFrom;
  }

  // v0.11 — procedure-only human-actuation steps (validated above).
  const requiresHuman = dedupe(options.requiresHuman);
  if (requiresHuman) itemData.requires_human = requiresHuman;

  // v0.5 Phase 2 — temporal validity. Validate early so callers see a
  // friendly error instead of a Zod schema dump from the writer.
  const assertIsoOrUndefined = (label: string, value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    if (Number.isNaN(Date.parse(value))) {
      throw new Error(`${label} must be a valid ISO 8601 timestamp (got "${value}")`);
    }
    return value;
  };
  const validFrom = assertIsoOrUndefined('valid_from', options.validFrom);
  const validTo = assertIsoOrUndefined('valid_to', options.validTo);
  if (validFrom !== undefined && validTo !== undefined && Date.parse(validFrom) > Date.parse(validTo)) {
    throw new Error(`valid_from (${validFrom}) must be <= valid_to (${validTo})`);
  }
  if (validFrom) itemData.valid_from = validFrom;
  if (validTo) itemData.valid_to = validTo;

  // v0.10 — caller-asserted conflict edges. Unlike the removed auto-attach,
  // these come from an explicit `--conflicts-with`, so they are validated to
  // exist and marked as `asserted` in `ext.edge_sources` (see types.ts). A
  // target already classified with a positive edge is a contradiction the
  // caller must resolve, not something we silently reconcile.
  const assertedConflicts = dedupe(options.conflictsWith);
  if (assertedConflicts) {
    const positiveTargets = new Set<string>([
      ...(options.refines ?? []),
      ...(options.supports ?? []),
      ...(options.dependsOn ?? []),
      ...(options.derivedFrom ?? []),
    ]);
    for (const targetId of assertedConflicts) {
      if (positiveTargets.has(targetId)) {
        throw new Error(
          `--conflicts-with ${targetId} contradicts a positive edge (refines/supports/depends_on) to the same target; declare one relationship, not both.`,
        );
      }
      if (!targetExists(targetId)) {
        throw new Error(`--conflicts-with target not found: ${targetId}`);
      }
    }
    itemData.conflicts_with = assertedConflicts;
    const edgeSources: Record<string, string> = {};
    for (const targetId of assertedConflicts) edgeSources[targetId] = 'asserted';
    itemData.ext = { ...(itemData.ext ?? {}), edge_sources: edgeSources };
  }

  // Tombstone override (CLI --allow-rejected): the record carries which
  // rejected values it re-asserts, who overrode, and when.
  if (rejectedValues.length > 0) {
    itemData.ext = {
      ...(itemData.ext ?? {}),
      rejected_value_overrides: rejectedValues.map((m) => ({
        id: m.id,
        reason: m.reason,
        ...(m.supersededBy ? { superseded_by: m.supersededBy } : {}),
        similarity: Number(m.similarity.toFixed(2)),
        overridden_at: created,
        overridden_by: source,
      })),
    };
  }

  // v0.13 — the relate rule for distinct_from, applied to every declared
  // target with the target's own edge lists in view (either record carrying
  // distinct_from next to another edge between the two is refused). For a
  // brand-new id the target side cannot name it yet; the shared check keeps
  // remember and relate on one rule.
  const edgeInputs: Array<[RelationType, string[] | undefined]> = [
    ['refines', itemData.refines],
    ['supports', itemData.supports],
    ['depends_on', itemData.depends_on],
    ['derived_from', itemData.derived_from],
    ['conflicts_with', itemData.conflicts_with],
    ['distinct_from', itemData.distinct_from],
  ];
  for (const [edgeType, ids] of edgeInputs) {
    for (const targetId of ids ?? []) {
      const target = lookups.map((l) => l.findById(targetId)).find((t): t is MemoryItem => t !== null);
      if (!target) continue;
      const clash = distinctFromExclusion(itemData, target, edgeType);
      if (clash) throw new Error(`remember refuses ${clash}`);
    }
  }

  // v0.11 — evidence attachments: every input above has passed, so copying is
  // now the last step before the write (see the validation note above).
  const evidenceEntries: EvidenceEntry[] = evidenceInputs.map((item) => attachEvidence(store.root, item));
  if (evidenceEntries.length > 0) itemData.evidence = evidenceEntries;

  const filePath = store.writeItem(itemData);

  // v0.11 — register the fresh record as an answer to a question in one call
  // (the question was validated before the write). Adding a live candidate to
  // a RESOLVED question reopens it; say so.
  let answeredQuestion: string | undefined;
  let reopenedQuestion = false;
  if (options.answersQuestion && answeredQuestionBefore) {
    const updated = addAnswers(store, options.answersQuestion, [id]);
    answeredQuestion = options.answersQuestion;
    reopenedQuestion = answeredQuestionBefore.state === 'resolved' && updated.state !== 'resolved';
  }

  const lines = [`Created ${type} memory ${id} at ${filePath}`];
  if (scope) {
    lines.push(`Scope: ${scope}`);
  }
  if (requiresHuman) {
    lines.push(`Requires human: ${requiresHuman.join('; ')}`);
  }
  if (derivedFrom) {
    lines.push(`Derived from: ${derivedFrom.join(', ')}`);
  }
  if (distinctFrom) {
    lines.push(`Distinct from: ${distinctFrom.join(', ')}`);
  }
  if (evidenceEntries.length > 0) {
    lines.push(`Evidence (${evidenceEntries.length}):`);
    for (const e of evidenceEntries) {
      lines.push(e.url ? `  url ${e.url}` : `  ${e.path} (sha256 ${e.sha256?.substring(0, 12)})`);
    }
  }
  if (answeredQuestion) {
    lines.push(
      reopenedQuestion
        ? `Answered question: ${answeredQuestion} (was resolved — REOPENED: state open, resolved_by cleared; resolve it again once one answer survives)`
        : `Answered question: ${answeredQuestion}`,
    );
  }
  if (anchorResolution.anchors.length > 0) {
    lines.push(`Anchored to ${anchorResolution.anchors.length} file(s):`);
    for (const a of anchorResolution.anchors) {
      lines.push(`  ${a.file} @ ${a.sha.substring(0, 12)}`);
    }
  }
  for (const w of anchorResolution.warnings) {
    lines.push(`⚠ ${w}`);
  }
  if (assertedConflicts) {
    lines.push(`Asserted conflicts_with: ${assertedConflicts.join(', ')}`);
  }
  if (rejectedValues.length > 0) {
    lines.push(`⚠ --allow-rejected: written over ${rejectedValues.length} rejected value(s), logged in ext.rejected_value_overrides:`);
    for (const m of rejectedValues) lines.push(`  ${describeRejection(m)}`);
  }
  if (suggestedConflicts && suggestedConflicts.length > 0) {
    lines.push(
      `Suggested conflicts (not written — wire with \`memspec relate --type conflicts_with\` if they genuinely contradict this):`,
    );
    for (const s of suggestedConflicts) {
      lines.push(`  ${s.id} "${s.title}" — ${s.rationale}`);
    }
  }

  return {
    id,
    filePath,
    message: lines.join('\n'),
    verified_with: verifiedWith,
    anchors: anchorResolution.anchors,
    anchorWarnings: anchorResolution.warnings,
    duplicates: duplicates && duplicates.length > 0 ? duplicates : undefined,
    suggestedConflicts: suggestedConflicts && suggestedConflicts.length > 0 ? suggestedConflicts : undefined,
    scope,
    evidence: evidenceEntries.length > 0 ? evidenceEntries : undefined,
    derived: derivedFrom ? true : undefined,
    requiresHuman: requiresHuman ?? undefined,
    answeredQuestion,
    reopenedQuestion: reopenedQuestion || undefined,
  };
}
