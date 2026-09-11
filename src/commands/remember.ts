import { resolve } from 'node:path';
import { ulid } from 'ulid';
import { projectRootForStore, resolveAnchorForWrite, type AnchorResolveOptions } from '../lib/anchors.js';
import { getDecayDays, loadConfig } from '../lib/config.js';
import {
  matchesConflictInferenceRule,
  normaliseTitle,
  rankByLexicalCloseness,
} from '../lib/inference.js';
import { effectiveSourceKind, inferSourceKind } from '../lib/source.js';
import { findPointer, POINTER_FILENAME, resolveLayerPath } from '../lib/registry.js';
import { assertKnownScope, resolveScopeForCwd } from '../lib/scope.js';
import { MemspecStore } from '../lib/store.js';
import { MEMORY_TYPES, type CodeAnchor, type MemoryType, type VerifiedWith } from '../lib/types.js';

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
  const pointer = findPointer(storeSelectionCwd);
  let storeCwd = storeSelectionCwd;
  if (pointer) {
    const writable = pointer.stores.filter((s) => s.writable);
    let target = writable.length === 1 ? writable[0] : undefined;
    if (options.store) {
      target = pointer.stores.find((s) => s.name === options.store);
      if (!target) {
        throw new Error(
          `no layer named '${options.store}' in ${pointer.dir}/${POINTER_FILENAME} (have: ${pointer.stores.map((s) => s.name).join(', ')})`
        );
      }
      if (!target.writable) throw new Error(`layer '${target.name}' is not writable`);
    }
    if (!target) {
      throw new Error(
        `ambiguous write target: ${writable.length} writable layers in scope (${writable.map((s) => s.name).join(', ')}) — pass --store <name> to say where this memory belongs`
      );
    }
    storeCwd = resolveLayerPath(target.path, pointer.dir);
  }

  const store = new MemspecStore(storeCwd);
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

  // Phase 5 — neighbour walk over same-type active records.
  // `store.search` is BM25-ranked and unbounded; we use it as a candidate
  // funnel and apply the (deterministic, explainable) lexical predicates
  // from inference.ts to decide refusal vs. auto-attach.
  let duplicates: DuplicateMatch[] | undefined;
  let suggestedConflicts: SuggestedConflict[] | undefined;
  try {
    // Scoped so a same-titled record in another project isn't treated as a
    // duplicate of this one. Unscoped and universal records stay visible.
    // Widen the window by the caller's declared targets: they are excluded
    // from inference below, so without this a declared parent at rank 1 could
    // push a genuine conflict out of the candidate window entirely.
    // Caller-asserted conflicts_with targets count as declared too (M2): they
    // are excluded from suggestions below, so widen the window by their count
    // as well or a genuine different conflict could be pushed out of it.
    const declaredCount = (options.refines?.length ?? 0) + (options.supports?.length ?? 0) + (options.dependsOn?.length ?? 0) + (options.conflictsWith?.length ?? 0);
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
    const callerDeclared = new Set<string>([
      ...(options.refines ?? []),
      ...(options.supports ?? []),
      ...(options.dependsOn ?? []),
      // A target the caller is asserting a conflict with is already classified;
      // re-suggesting it as a conflict is noise (M2).
      ...(options.conflictsWith ?? []),
    ]);

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

  // Witness: anchors present and resolved → anchor; operator source → operator; else assertion.
  let verifiedWith: VerifiedWith = 'assertion';
  if (anchorResolution.anchors.length > 0) {
    verifiedWith = 'anchor';
  } else if (incomingSourceKind === 'operator') {
    verifiedWith = 'operator';
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
    ]);
    for (const targetId of assertedConflicts) {
      if (positiveTargets.has(targetId)) {
        throw new Error(
          `--conflicts-with ${targetId} contradicts a positive edge (refines/supports/depends_on) to the same target; declare one relationship, not both.`,
        );
      }
      if (!store.findById(targetId)) {
        throw new Error(`--conflicts-with target not found: ${targetId}`);
      }
    }
    itemData.conflicts_with = assertedConflicts;
    const edgeSources: Record<string, string> = {};
    for (const targetId of assertedConflicts) edgeSources[targetId] = 'asserted';
    itemData.ext = { ...(itemData.ext ?? {}), edge_sources: edgeSources };
  }

  const filePath = store.writeItem(itemData);

  const lines = [`Created ${type} memory ${id} at ${filePath}`];
  if (scope) {
    lines.push(`Scope: ${scope}`);
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
  };
}
