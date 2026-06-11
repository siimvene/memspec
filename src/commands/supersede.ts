import { ulid } from 'ulid';
import { getDecayDays, loadConfig } from '../lib/config.js';
import { effectiveSourceKind } from '../lib/source.js';
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
 * v0.3 entry point for retracting, replacing, or merging memories.
 *
 * - `body` empty + no `mergeFrom` → retraction. Target moves to superseded.
 * - `body` filled → replacement. New record minted; target points at it.
 * - `mergeFrom` set → every id in the array collapses into the survivor.
 *   When `body` is provided, the survivor is the new replacement record.
 *   When `body` is empty, the survivor is `id`; `mergeFrom` ids collapse into it.
 */
export function runSupersede(targetId: string, options: SupersedeOptions): SupersedeResult {
  const store = new MemspecStore(options.cwd);

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

    store.writeItem({
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
    });

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
      supersedes: merged,
      supersede_reason: baseReason,
    });

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

  return {
    survivor_id: target.id,
    superseded_ids: [target.id],
    reason: targetReason,
    message: `Retracted ${targetId}\nReason: ${targetReason}`,
  };
}
