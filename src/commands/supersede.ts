import { ulid } from 'ulid';
import { getDecayDays, loadConfig } from '../lib/config.js';
import { appendOutcome } from '../lib/outcomes.js';
import { effectiveSourceKind, sourceDowngradeWarning, sourceForChannel } from '../lib/source.js';
import { assertKnownScope } from '../lib/scope.js';
import { withFileLock } from '../lib/lock.js';
import { claimShape, claimTokens, tokenWeight } from '../lib/similarity.js';
import {
  CLAIM_WRITE_LOCK,
  mergedPieceError,
  readViewClaimIndex,
  rejectedValueError,
  rejectedValueOverrides,
  scanArchive,
  type RejectedValueMatch,
} from '../lib/tombstone.js';
import { CompositeStore, type StoreLayer } from '../lib/composite-store.js';
import { MemspecStore } from '../lib/store.js';
import { DEFAULT_DECAY_DAYS, type EvidenceEntry, type MemoryItem, type MemoryType } from '../lib/types.js';

export interface SupersedeOptions {
  cwd?: string;
  reason: string;
  /** Replacement body. If omitted (and no merge_from), the target is retracted. */
  body?: string;
  /** Optional fresh title for the replacement. Defaults to the survivor's title. */
  title?: string;
  /**
   * v0.3: collapse N records into one. Each id in `mergeFrom` transitions to
   * `superseded` with `superseded_by` pointing at the surviving record. The
   * survivor is `id` if no `body` is provided, otherwise the freshly-minted
   * replacement.
   */
  mergeFrom?: string[];
  /** Required to supersede an operator-sourced record. Honoured only on the CLI channel. */
  overrideOperator?: boolean;
  /**
   * Which surface invoked this. Write authority over operator memory derives
   * from the channel, never from a caller flag: on `mcp` every branch
   * (replace, retract, merge_from, and a merge INTO an operator survivor)
   * refuses operator-sourced records whatever `overrideOperator` says, so an
   * agent cannot self-authorize. The MCP tool does not expose the override.
   * Same rule as `unrelate`.
   */
  channel?: 'cli' | 'mcp';
  source?: string;
  /**
   * Scope for the survivor. Overrides inheritance entirely, and is the answer
   * to the error a merge of disagreeing scopes raises. Pass `universal` to
   * reclassify the survivor as visible everywhere; there is deliberately no way
   * to ask for "no scope" here, because absent means "not yet classified" and a
   * caller who has been asked to classify is past that.
   */
  scope?: string;
  /**
   * Write the replacement even though its body near-matches a value an
   * earlier supersede rejected (the tombstone, lib/tombstone.ts). Honoured
   * only on the CLI channel; logged into the replacement's
   * `ext.rejected_value_overrides`. Over MCP the refusal is final.
   */
  allowRejected?: boolean;
}

export interface SupersedeResult {
  survivor_id: string;
  superseded_ids: string[];
  reason: string;
  message: string;
  /**
   * Set when the target lives in a read-only layer: the replacement was
   * written to the one writable layer with `supersedes: [target_id]`, the
   * read-only file was left alone, and the read view now treats the target as
   * superseded. The supersession reaches `layer` itself only when the
   * replacement is promoted there (`memspec status` lists what is pending).
   */
  pending_promotion?: { layer: string; target_id: string };
  /** Set when an operator-pattern source was downgraded to agent tier (MCP channel). */
  source_warning?: string;
}

/**
 * How a record left the active set, stamped on the archived record as
 * `ext.supersede_kind`. The tombstone (lib/tombstone.ts) reads it: a
 * `replace` or `retract` rejected the record's value, a `merge` consolidated
 * it into a survivor that still holds it (restating the piece is a
 * near-duplicate of the survivor, never a rejected value). Per record: in a
 * supersede with a replacement body, the target is `replace` (its value is
 * what the body corrects) and every `merge_from` id is `merge` (consolidated
 * into the new record, dream-style); a merge into an existing survivor (no
 * body) stamps `merge` on each piece. The survivor's `supersedes` list cannot
 * tell the kinds apart on its own.
 */
export type SupersedeKind = 'replace' | 'merge' | 'retract';

function markSuperseded(item: MemoryItem, kind: SupersedeKind): void {
  item.ext = { ...(item.ext ?? {}), supersede_kind: kind };
}

function decayDaysFor(type: MemoryType | undefined, root: string): number {
  if (!type) return DEFAULT_DECAY_DAYS.fact;
  return getDecayDays(loadConfig(root), type);
}

/** The refusal for operator memory reached over MCP: names the terminal command a human runs instead. */
function operatorOverMcpError(item: MemoryItem): Error {
  return new Error(
    `"${item.id}" is operator-sourced (source: ${item.source}). ` +
      'Superseding operator memory is not available over MCP; a human runs ' +
      `\`memspec supersede ${item.id} --override-operator --reason "..."\` from a terminal (add --body for a replacement, --merge-from for a merge).`,
  );
}

function assertSupersedable(item: MemoryItem, overrideOperator: boolean, reason: string, channel?: 'cli' | 'mcp'): string {
  if (item.state !== 'active') {
    throw new Error(`Item "${item.id}" is ${item.state}, not active`);
  }
  if (effectiveSourceKind(item) === 'operator' && channel === 'mcp') {
    throw operatorOverMcpError(item);
  }
  if (effectiveSourceKind(item) === 'operator' && !overrideOperator) {
    throw new Error(
      `"${item.id}" is operator-sourced (source: ${item.source}). ` +
      'Superseding operator knowledge requires override_operator: true; use it only with explicit cause.',
    );
  }
  if (effectiveSourceKind(item) === 'operator' && overrideOperator) {
    return `${reason} [override_operator used on operator-sourced record]`;
  }
  return reason;
}

/**
 * The tombstone (lib/tombstone.ts) for the claim text a supersede leaves
 * active (a replacement body, or the survivor of a no-body merge), judged
 * against the state the supersede produces: `replaced` / `merged` are the ids
 * this write archives, `newId` the record that holds the claim afterwards.
 * The archive scanned is every layer of `view` plus `store` (tombstone.ts
 * `readViewClaimIndex`). Throws the refusal; on the CLI with `allowRejected`
 * returns the matches to log on the record. A restated merged piece refuses
 * over MCP only: the CLI supersede is the operator's consolidation path and
 * never ran a near-duplicate check.
 */
function assertNoRejectedValue(
  store: MemspecStore,
  view: CompositeStore,
  claim: { title: string; body: string },
  pending: { newId: string; replaced: string[]; merged: string[] },
  options: SupersedeOptions,
): RejectedValueMatch[] {
  const viaMcp = options.channel === 'mcp';
  const tokens = claimTokens(claim.title, claim.body);
  const scan = scanArchive(
    readViewClaimIndex(store, [view]),
    { tokens, weight: tokenWeight(tokens), shape: claimShape(claim.title, claim.body) },
    pending,
  );
  if (scan.rejected.length > 0 && (viaMcp || !options.allowRejected)) {
    throw rejectedValueError('supersede', scan.rejected, viaMcp);
  }
  if (viaMcp && scan.merged.length > 0) throw mergedPieceError('supersede', scan.merged, true);
  return scan.rejected;
}

function overrideNote(matches: RejectedValueMatch[], id: string): string {
  return matches.length > 0
    ? `\n⚠ --allow-rejected: ${id} written over ${matches.length} rejected value(s), logged in ext.rejected_value_overrides`
    : '';
}

/**
 * v0.11 fields the replacement inherits from the records collapsing into it:
 * the union of `requires_human` steps (order preserved, deduped) and the union
 * of `evidence` entries (deduped by sha256 for files, url for pointers).
 */
function carryV011Fields(contributors: MemoryItem[]): { requiresHuman: string[]; evidence: EvidenceEntry[] } {
  const requiresHuman: string[] = [];
  const evidence: EvidenceEntry[] = [];
  const seenEvidence = new Set<string>();
  for (const item of contributors) {
    for (const step of item.requires_human ?? []) {
      if (!requiresHuman.includes(step)) requiresHuman.push(step);
    }
    for (const entry of item.evidence ?? []) {
      const key = entry.sha256 ? `sha:${entry.sha256}` : entry.url ? `url:${entry.url}` : JSON.stringify(entry);
      if (seenEvidence.has(key)) continue;
      seenEvidence.add(key);
      evidence.push(entry);
    }
  }
  return { requiresHuman, evidence };
}

/**
 * Scope the survivor inherits from the records collapsing into it: unanimity,
 * or a refusal to guess.
 *
 * No silent rule can be right here, because the two failure directions are
 * mutually exclusive. Resolving `alpha` + `beta` to absent republishes the
 * merged content to `gamma` and every other unrelated scope — the exact
 * pollination scoping exists to prevent. Resolving absent + `alpha` to `alpha`
 * hides content that every scope could previously read. Treating absent as an
 * abstention rather than a value only picks one of those losses; it does not
 * avoid either. So a mixed set is a question for the caller, the same way
 * `remember` refuses to pick a store when more than one is writable.
 *
 * A plain supersede has exactly one contributor, so it is trivially unanimous
 * and keeps inheriting silently — the common path pays nothing for this.
 */
function inheritedScope(contributors: MemoryItem[]): string | undefined {
  const scopes = new Set(contributors.map((item) => item.scope));
  if (scopes.size <= 1) return [...scopes][0];

  const conflicting = [...scopes].map((scope) => scope ?? '(none)').sort().join(', ');
  throw new Error(
    `Cannot infer the survivor's scope: the records being merged carry ${conflicting}. ` +
    'Say where the merged knowledge belongs with an explicit scope — ' +
    '--scope <name> for one project, or --scope universal if it belongs everywhere.',
  );
}

/**
 * Supersede of a record that lives in a READ-ONLY layer (e.g. a team store
 * bound by path, corrected only through a PR to its own repo). Returns null
 * when the target is not in a read-only layer, or when this cannot proceed —
 * the caller then falls through to `assertWritableLayerForId`, which raises
 * the existing refusal naming the layer.
 *
 * Proceeds only for a REPLACEMENT (a body; no `merge_from`) and only when the
 * read view has exactly one writable layer: a guessed write target is how team
 * knowledge leaks into the wrong store, so an ambiguous view keeps refusing.
 * A retraction has no local record to carry it, and a merge would mix
 * read-only and local lifecycles in one operation; both still refuse.
 *
 * The replacement is written to the writable layer with
 * `supersedes: [targetId]`; the read-only file is never touched. The read view
 * (`CompositeStore.pendingPromotions`) then hides the target from active
 * results, and `memspec status` lists the pair so the promotion PR can be
 * built from it.
 */
function crossLayerTarget(composite: CompositeStore, targetId: string, options: SupersedeOptions): SupersedeResult | null {
  const owner = composite.layerForId(targetId);
  if (!owner || owner.writable) return null;
  const body = options.body;
  if (body === undefined || body === null) return null;
  if ((options.mergeFrom ?? []).some((id) => id !== targetId)) return null;
  const writable = composite.layers.filter((l) => l.writable);
  if (writable.length !== 1) return null;
  const local = writable[0];

  const target = owner.store.findById(targetId);
  if (!target) return null;
  local.store.init();
  return withSupersedeLock(local.store.root, targetId, () =>
    withFileLock(local.store.root, CLAIM_WRITE_LOCK, () => writeCrossLayerReplacement(composite, owner, local, target, body, options), { waitMs: 10_000 }),
  );
}

/**
 * Run `fn` holding the per-target supersede lock in the writable layer's
 * machine-local subtree (`local/locks/supersede-<target>.lock`, lib/lock.ts).
 * Two processes superseding the same read-only record could otherwise both
 * pass the "already superseded in this view" guard and both write an active
 * replacement: the guard reads the store, the write lands after it, and
 * nothing orders the two.
 */
function withSupersedeLock<T>(storeRoot: string, targetId: string, fn: () => T): T {
  return withFileLock(storeRoot, `supersede-${targetId}`, fn, {
    busyMessage: (path) =>
      `another supersede of "${targetId}" is in progress (lock ${path}); retry in a moment, ` +
      'or delete the lock file if no memspec process is running',
  });
}

/** The check + write half of `crossLayerTarget`, run under the per-target lock. */
function writeCrossLayerReplacement(
  composite: CompositeStore,
  owner: StoreLayer,
  local: StoreLayer,
  target: MemoryItem,
  body: string,
  options: SupersedeOptions,
): SupersedeResult {
  const targetId = target.id;
  // A second local replacement would fork the correction: two active local
  // records claiming one target, only one of which the view honours. The
  // live record is the one to supersede. Read fresh, under the lock: another
  // process may have written one since this view was loaded.
  const existing = composite.pendingPromotions({ fresh: true }).get(targetId);
  if (existing) {
    throw new Error(
      `"${targetId}" is already superseded in this view by ${existing.id} (pending promotion to layer '${owner.name}'); ` +
        `supersede ${existing.id} instead`,
    );
  }
  const reason = assertSupersedable(target, options.overrideOperator ?? false, options.reason, options.channel);

  // Scope is validated against the store the record is written to.
  const explicitScope = options.scope !== undefined
    ? assertKnownScope(loadConfig(local.store.root).scopes, options.scope, () => local.store.scopesInUse())
    : undefined;
  const scope = explicitScope ?? target.scope;

  const newId = `ms_${ulid()}`;
  // The scan covers every layer of the view (the read-only owner included),
  // the same archive `remember` scans.
  const overrides = assertNoRejectedValue(local.store, composite, { title: options.title ?? target.title, body }, { newId, replaced: [targetId], merged: [] }, options);
  const now = new Date().toISOString();
  const expires = new Date();
  expires.setUTCDate(expires.getUTCDate() + decayDaysFor(target.type, local.store.root));
  // Over MCP an operator-pattern source is stored at agent tier (lib/source.ts).
  const { source, claimed } = sourceForChannel(options.source ?? 'unknown', options.channel);

  const replacement: Parameters<typeof local.store.writeItem>[0] = {
    id: newId,
    kind: 'claim',
    type: target.type,
    state: 'active',
    created: now,
    source,
    tags: target.tags,
    check_by: expires.toISOString(),
    last_verified: now,
    supersedes: [targetId],
    supersede_reason: reason,
    title: options.title ?? target.title,
    body,
  };
  if (scope) replacement.scope = scope;
  const carried = carryV011Fields([target]);
  if (carried.requiresHuman.length > 0) replacement.requires_human = carried.requiresHuman;
  if (carried.evidence.length > 0) replacement.evidence = carried.evidence;
  if (claimed) replacement.ext = { claimed_source: claimed };
  if (overrides.length > 0) {
    replacement.ext = { ...(replacement.ext ?? {}), rejected_value_overrides: rejectedValueOverrides(overrides, now, source) };
  }

  local.store.writeItem(replacement);
  appendOutcome(local.store.root, targetId, 'corrected', { source, note: reason });

  return {
    survivor_id: newId,
    superseded_ids: [targetId],
    reason,
    pending_promotion: { layer: owner.name, target_id: targetId },
    ...(claimed ? { source_warning: sourceDowngradeWarning(claimed, source) } : {}),
    message:
      `Superseded ${targetId} → ${newId} in this view (written to layer '${local.name}')\n` +
      `Reason: ${reason}\n` +
      `Pending promotion: ${targetId} lives in read-only layer '${owner.name}' and is unchanged there; ` +
      `promote ${newId} to '${owner.name}' to supersede it for everyone (memspec status lists pending promotions)` +
      (claimed ? `\n⚠ ${sourceDowngradeWarning(claimed, source)}` : '') +
      overrideNote(overrides, newId),
  };
}

/**
 * v0.3 entry point for retracting, replacing, or merging memories.
 *
 * - `body` empty + no `mergeFrom` → retraction. Target moves to superseded.
 * - `body` filled → replacement. New record minted; target points at it.
 * - `mergeFrom` set → every id in the array collapses into the survivor.
 *   When `body` is provided, the survivor is the new replacement record.
 *   When `body` is empty, the survivor is `id`; `mergeFrom` ids collapse into it.
 */
export function runSupersede(targetId: string, options: SupersedeOptions): SupersedeResult {
  // Resolve the layer owning the target so a supersede of a record in a
  // read-only store layer refuses (naming the layer) instead of silently
  // writing. A non-layered store resolves to its single writable layer, so the
  // owning store is byte-identical to `new MemspecStore(options.cwd)`.
  const composite = CompositeStore.forCwd(options.cwd);
  const crossLayer = crossLayerTarget(composite, targetId, options);
  if (crossLayer) return crossLayer;
  const owner = composite.assertWritableLayerForId(targetId);
  const store = owner ? owner.store : new MemspecStore(options.cwd);
  // Not found: refuse before the lock, which would create the store's
  // local/locks directory under a cwd that holds no store.
  if (!store.findById(targetId)) {
    throw new Error(`Memory item "${targetId}" not found`);
  }
  // Every branch changes what the tombstone reads (a new claim, an archived
  // record): the store-wide claim-write lock `remember` holds serializes the
  // two, so a remember's check cannot interleave with a supersede's write.
  return withFileLock(store.root, CLAIM_WRITE_LOCK, () => supersedeInStore(store, composite, targetId, options), { waitMs: 10_000 });
}

/** The check + write half of `runSupersede`, run under the store's claim-write lock. */
function supersedeInStore(store: MemspecStore, view: CompositeStore, targetId: string, options: SupersedeOptions): SupersedeResult {
  const target = store.findById(targetId);
  if (!target) {
    throw new Error(`Memory item "${targetId}" not found`);
  }

  const mergeFromIds = (options.mergeFrom ?? []).filter((id) => id !== targetId);
  const mergeItems: MemoryItem[] = [];
  for (const id of mergeFromIds) {
    const item = store.findById(id);
    if (!item) {
      throw new Error(`merge_from target "${id}" not found`);
    }
    mergeItems.push(item);
  }

  // Over MCP an operator-pattern source is stored at agent tier (lib/source.ts):
  // the replacement and the outcome log carry the downgraded string.
  const { source, claimed } = sourceForChannel(options.source ?? 'unknown', options.channel);
  const sourceWarning = claimed ? sourceDowngradeWarning(claimed, source) : undefined;
  const downgradeNote = sourceWarning ? `\n⚠ ${sourceWarning}` : '';
  const warningField = sourceWarning ? { source_warning: sourceWarning } : {};
  const overrideOperator = options.overrideOperator ?? false;
  const baseReason = options.reason;

  // Validated against the config plus the scopes actually stamped in the store,
  // resolved as a thunk so a name the config already declares never pays for a
  // full re-parse of every record.
  const explicitScope = options.scope !== undefined
    ? assertKnownScope(loadConfig(store.root).scopes, options.scope, () => store.scopesInUse())
    : undefined;
  const survivorScope = explicitScope ?? inheritedScope([target, ...mergeItems]);

  // Replacement branch: mint a fresh record. Everything in mergeFrom plus the
  // target collapse into the new survivor.
  if (options.body !== undefined && options.body !== null) {
    const targetReason = assertSupersedable(target, overrideOperator, baseReason, options.channel);
    const mergeReasons = mergeItems.map((item) => assertSupersedable(item, overrideOperator, baseReason, options.channel));

    const newId = `ms_${ulid()}`;
    const collapsedIds = [target.id, ...mergeItems.map((i) => i.id)];
    const replacementTitle = options.title ?? target.title;
    const overrides = assertNoRejectedValue(
      store,
      view,
      { title: replacementTitle, body: options.body },
      { newId, replaced: [target.id], merged: mergeItems.map((i) => i.id) },
      options,
    );
    const now = new Date().toISOString();
    const expires = new Date();
    expires.setUTCDate(expires.getUTCDate() + decayDaysFor(target.type, store.root));

    const replacement: Parameters<typeof store.writeItem>[0] = {
      id: newId,
      kind: 'claim',
      type: target.type,
      state: 'active',
      created: now,
      source,
      tags: target.tags,
      check_by: expires.toISOString(),
      last_verified: now,
      supersedes: collapsedIds,
      supersede_reason: baseReason,
      title: replacementTitle,
      body: options.body,
    };
    // A correction to a scoped claim is still that scope's knowledge. Omitted
    // when nothing was inherited: absent and `universal` are different
    // classifications, so an unscoped target must not gain one here.
    if (survivorScope) {
      replacement.scope = survivorScope;
    }
    // v0.11 fields ride along to the replacement. `requires_human` is the
    // actuation boundary: a revised procedure body does not make the
    // human-only step safe for an unattended runner, so dropping it silently
    // (as the fixed field list above used to) removed a safety rule with no
    // trace on the new record. Committed evidence stays attached to the
    // claim's lineage too — the files are content-addressed in the store.
    const carried = carryV011Fields([target, ...mergeItems]);
    if (carried.requiresHuman.length > 0) replacement.requires_human = carried.requiresHuman;
    if (carried.evidence.length > 0) replacement.evidence = carried.evidence;
    if (claimed) replacement.ext = { claimed_source: claimed };
    if (overrides.length > 0) {
      replacement.ext = { ...(replacement.ext ?? {}), rejected_value_overrides: rejectedValueOverrides(overrides, now, source) };
    }
    store.writeItem(replacement);

    // Per record: the target's value is what the body corrects (`replace`,
    // tombstoned); each merge_from id is consolidated into the new record
    // (`merge`: restating it is a near-duplicate of the survivor). A caller
    // correcting twins names the wrong one as the target, or supersedes each.
    target.state = 'superseded';
    target.superseded_by = newId;
    target.supersede_reason = targetReason;
    markSuperseded(target, 'replace');
    store.moveToArchive(target, 'superseded');

    for (let i = 0; i < mergeItems.length; i++) {
      const item = mergeItems[i];
      item.state = 'superseded';
      item.superseded_by = newId;
      item.supersede_reason = mergeReasons[i];
      markSuperseded(item, 'merge');
      store.moveToArchive(item, 'superseded');
    }

    for (const collapsedId of collapsedIds) {
      appendOutcome(store.root, collapsedId, 'corrected', { source, note: baseReason });
    }

    const mergedNote = mergeItems.length > 0 ? ` (merged ${mergeItems.length + 1} → 1)` : '';
    const carriedNotes: string[] = [];
    if (carried.requiresHuman.length > 0) carriedNotes.push(`requires_human (${carried.requiresHuman.length} step(s))`);
    if (carried.evidence.length > 0) carriedNotes.push(`evidence (${carried.evidence.length} entr${carried.evidence.length === 1 ? 'y' : 'ies'})`);
    const carriedLine = carriedNotes.length > 0 ? `\nCarried to ${newId}: ${carriedNotes.join(', ')}` : '';
    return {
      survivor_id: newId,
      superseded_ids: collapsedIds,
      reason: baseReason,
      ...warningField,
      message: `Superseded ${collapsedIds.join(', ')} → ${newId}${mergedNote}\nReason: ${baseReason}${carriedLine}${downgradeNote}${overrideNote(overrides, newId)}`,
    };
  }

  // Merge branch with no replacement: target IS the survivor. Every merge_from
  // id collapses into it.
  if (mergeItems.length > 0) {
    if (target.state !== 'active') {
      throw new Error(`Survivor "${targetId}" is ${target.state}, not active`);
    }
    // The survivor is rewritten too (supersedes, supersede_reason, scope), so
    // an operator survivor gets the same guard as an operator target: refused
    // over MCP, and on the CLI only with --override-operator (logged into the
    // survivor's persisted reason).
    const survivorReason = assertSupersedable(target, overrideOperator, baseReason, options.channel);

    const mergeReasons = mergeItems.map((item) => assertSupersedable(item, overrideOperator, baseReason, options.channel));

    // The survivor's own text is the claim this merge leaves active: when a
    // merged record is the current survivor of a correction, the correction's
    // place moves to `target` (tombstone.ts "Place transfer"). Merging the
    // current-value record into a record still stating the rejected value
    // would otherwise make the old value the chain's active end.
    const overrides = assertNoRejectedValue(
      store,
      view,
      { title: target.title, body: target.body ?? '' },
      { newId: target.id, replaced: [], merged: mergeItems.map((i) => i.id) },
      options,
    );

    const collapsedIds: string[] = [];
    for (let i = 0; i < mergeItems.length; i++) {
      const item = mergeItems[i];
      item.state = 'superseded';
      item.superseded_by = target.id;
      item.supersede_reason = mergeReasons[i];
      markSuperseded(item, 'merge');
      store.moveToArchive(item, 'superseded');
      collapsedIds.push(item.id);
    }

    // Record the merge on the survivor: extend its supersedes array.
    const existingSupersedes = target.supersedes ?? [];
    const merged = [...existingSupersedes];
    for (const id of collapsedIds) {
      if (!merged.includes(id)) merged.push(id);
    }
    // A survivor cannot both supersede a record and call it distinct
    // ("compared, independent"): drop distinct_from edges to every id it now
    // supersedes.
    const distinctFrom = (target.distinct_from ?? []).filter((id) => !merged.includes(id));
    store.updateItem({
      ...target,
      // The survivor absorbs records from possibly-different scopes, so its own
      // stamp is re-derived from the whole contributing set rather than kept.
      // Only reached once that set agreed, or the caller named a scope.
      scope: survivorScope,
      supersedes: merged,
      supersede_reason: survivorReason,
      distinct_from: distinctFrom.length > 0 ? distinctFrom : undefined,
      ...(overrides.length > 0
        ? {
            ext: {
              ...(target.ext ?? {}),
              rejected_value_overrides: [
                ...(Array.isArray(target.ext?.rejected_value_overrides) ? target.ext.rejected_value_overrides as Array<Record<string, unknown>> : []),
                ...rejectedValueOverrides(overrides, new Date().toISOString(), source),
              ],
            },
          }
        : {}),
    });

    for (const collapsedId of collapsedIds) {
      appendOutcome(store.root, collapsedId, 'corrected', { source, note: baseReason });
    }

    return {
      survivor_id: target.id,
      superseded_ids: collapsedIds,
      reason: survivorReason,
      ...warningField,
      message: `Merged ${collapsedIds.join(', ')} → ${target.id} (${collapsedIds.length} record(s) collapsed)\nReason: ${survivorReason}${downgradeNote}${overrideNote(overrides, target.id)}`,
    };
  }

  // Retraction branch: no body, no merge. Target moves to superseded with reason.
  const targetReason = assertSupersedable(target, overrideOperator, baseReason, options.channel);
  target.state = 'superseded';
  target.supersede_reason = targetReason;
  markSuperseded(target, 'retract');
  store.moveToArchive(target, 'superseded');
  appendOutcome(store.root, target.id, 'corrected', { source, note: targetReason });

  return {
    survivor_id: target.id,
    superseded_ids: [target.id],
    reason: targetReason,
    ...warningField,
    message: `Retracted ${targetId}\nReason: ${targetReason}${downgradeNote}`,
  };
}
