import { ulid } from 'ulid';
import { getDecayDays, loadConfig } from '../lib/config.js';
import { appendOutcome } from '../lib/outcomes.js';
import { effectiveSourceKind } from '../lib/source.js';
import { assertKnownScope } from '../lib/scope.js';
import { CompositeStore } from '../lib/composite-store.js';
import { MemspecStore } from '../lib/store.js';
import { DEFAULT_DECAY_DAYS, type MemoryItem, type MemoryType } from '../lib/types.js';

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
  overrideOperator?: boolean;
  source?: string;
  /**
   * Scope for the survivor. Overrides inheritance entirely, and is the answer
   * to the error a merge of disagreeing scopes raises. Pass `universal` to
   * reclassify the survivor as visible everywhere; there is deliberately no way
   * to ask for "no scope" here, because absent means "not yet classified" and a
   * caller who has been asked to classify is past that.
   */
  scope?: string;
}

export interface SupersedeResult {
  survivor_id: string;
  superseded_ids: string[];
  reason: string;
  message: string;
}

function decayDaysFor(type: MemoryType | undefined, root: string): number {
  if (!type) return DEFAULT_DECAY_DAYS.fact;
  return getDecayDays(loadConfig(root), type);
}

function assertSupersedable(item: MemoryItem, overrideOperator: boolean, reason: string): string {
  if (item.state !== 'active') {
    throw new Error(`Item "${item.id}" is ${item.state}, not active`);
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
  const owner = composite.assertWritableLayerForId(targetId);
  const store = owner ? owner.store : new MemspecStore(options.cwd);

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

  const source = options.source ?? 'unknown';
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
    const targetReason = assertSupersedable(target, overrideOperator, baseReason);
    const mergeReasons = mergeItems.map((item) => assertSupersedable(item, overrideOperator, baseReason));

    const newId = `ms_${ulid()}`;
    const now = new Date().toISOString();
    const expires = new Date();
    expires.setUTCDate(expires.getUTCDate() + decayDaysFor(target.type, store.root));

    const collapsedIds = [target.id, ...mergeItems.map((i) => i.id)];

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
      title: options.title ?? target.title,
      body: options.body,
    };
    // A correction to a scoped claim is still that scope's knowledge. Omitted
    // when nothing was inherited: absent and `universal` are different
    // classifications, so an unscoped target must not gain one here.
    if (survivorScope) {
      replacement.scope = survivorScope;
    }
    store.writeItem(replacement);

    target.state = 'superseded';
    target.superseded_by = newId;
    target.supersede_reason = targetReason;
    store.moveToArchive(target, 'superseded');

    for (let i = 0; i < mergeItems.length; i++) {
      const item = mergeItems[i];
      item.state = 'superseded';
      item.superseded_by = newId;
      item.supersede_reason = mergeReasons[i];
      store.moveToArchive(item, 'superseded');
    }

    for (const collapsedId of collapsedIds) {
      appendOutcome(store.root, collapsedId, 'corrected', { source, note: baseReason });
    }

    const mergedNote = mergeItems.length > 0 ? ` (merged ${mergeItems.length + 1} → 1)` : '';
    return {
      survivor_id: newId,
      superseded_ids: collapsedIds,
      reason: baseReason,
      message: `Superseded ${collapsedIds.join(', ')} → ${newId}${mergedNote}\nReason: ${baseReason}`,
    };
  }

  // Merge branch with no replacement: target IS the survivor. Every merge_from
  // id collapses into it.
  if (mergeItems.length > 0) {
    if (target.state !== 'active') {
      throw new Error(`Survivor "${targetId}" is ${target.state}, not active`);
    }

    const mergeReasons = mergeItems.map((item) => assertSupersedable(item, overrideOperator, baseReason));

    const collapsedIds: string[] = [];
    for (let i = 0; i < mergeItems.length; i++) {
      const item = mergeItems[i];
      item.state = 'superseded';
      item.superseded_by = target.id;
      item.supersede_reason = mergeReasons[i];
      store.moveToArchive(item, 'superseded');
      collapsedIds.push(item.id);
    }

    // Record the merge on the survivor: extend its supersedes array.
    const existingSupersedes = target.supersedes ?? [];
    const merged = [...existingSupersedes];
    for (const id of collapsedIds) {
      if (!merged.includes(id)) merged.push(id);
    }
    store.updateItem({
      ...target,
      // The survivor absorbs records from possibly-different scopes, so its own
      // stamp is re-derived from the whole contributing set rather than kept.
      // Only reached once that set agreed, or the caller named a scope.
      scope: survivorScope,
      supersedes: merged,
      supersede_reason: baseReason,
    });

    for (const collapsedId of collapsedIds) {
      appendOutcome(store.root, collapsedId, 'corrected', { source, note: baseReason });
    }

    return {
      survivor_id: target.id,
      superseded_ids: collapsedIds,
      reason: baseReason,
      message: `Merged ${collapsedIds.join(', ')} → ${target.id} (${collapsedIds.length} record(s) collapsed)\nReason: ${baseReason}`,
    };
  }

  // Retraction branch: no body, no merge. Target moves to superseded with reason.
  const targetReason = assertSupersedable(target, overrideOperator, baseReason);
  target.state = 'superseded';
  target.supersede_reason = targetReason;
  store.moveToArchive(target, 'superseded');
  appendOutcome(store.root, target.id, 'corrected', { source, note: targetReason });

  return {
    survivor_id: target.id,
    superseded_ids: [target.id],
    reason: targetReason,
    message: `Retracted ${targetId}\nReason: ${targetReason}`,
  };
}
