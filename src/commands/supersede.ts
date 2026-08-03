import { ulid } from 'ulid';
import { getDecayDays, loadConfig } from '../lib/config.js';
import { effectiveSourceKind } from '../lib/source.js';
import { assertKnownScope } from '../lib/scope.js';
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
   * Scope for the survivor. Overrides the scope inherited from the records
   * being collapsed. Pass `universal` to reclassify the survivor as visible
   * everywhere; there is deliberately no way to ask for "no scope" here,
   * because that is what inheritance already produces when nothing agrees.
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
 * Scope the survivor inherits from the records collapsing into it.
 *
 * Contributors with no scope abstain rather than vote: they are already
 * visible from every scope, so they cannot disagree with anyone. A genuine
 * disagreement resolves to absent, never to one of the competing names —
 * under-scoping leaves a record visible where it wasn't before, over-scoping
 * makes it vanish from every project but one, and only the second is
 * unrecoverable from the reader's side.
 */
function inheritedScope(contributors: MemoryItem[]): string | undefined {
  const scopes = new Set(
    contributors.map((item) => item.scope).filter((scope): scope is string => Boolean(scope)),
  );
  return scopes.size === 1 ? [...scopes][0] : undefined;
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
      // Undefined drops the field on serialisation, which is the safe direction.
      scope: survivorScope,
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
