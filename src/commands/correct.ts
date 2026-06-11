import { ulid } from 'ulid';
import { getDecayDays, loadConfig } from '../lib/config.js';
import { effectiveSourceKind } from '../lib/source.js';
import { MemspecStore } from '../lib/store.js';
import { DEFAULT_DECAY_DAYS, type MemoryType } from '../lib/types.js';

export interface CorrectOptions {
  cwd?: string;
  reason: string;
  replace?: string;
  title?: string;
  supersedeBy?: string;
  overrideOperator?: boolean;
  source?: string;
}

function decayDaysFor(type: MemoryType | undefined, root: string): number {
  if (!type) return DEFAULT_DECAY_DAYS.fact;
  return getDecayDays(loadConfig(root), type);
}

export function runCorrect(targetId: string, options: CorrectOptions): string {
  const store = new MemspecStore(options.cwd);

  const target = store.findById(targetId);
  if (!target) {
    throw new Error(`Memory item "${targetId}" not found`);
  }

  if (target.state !== 'active') {
    throw new Error(`Item "${targetId}" is ${target.state}, not active`);
  }

  if (options.replace && options.supersedeBy) {
    throw new Error('--replace and --supersede-by are mutually exclusive');
  }

  // Operator-sourced records are protected: correcting one requires an
  // explicit override, and the override is logged into the durable reason.
  let reason = options.reason;
  if (effectiveSourceKind(target) === 'operator') {
    if (!options.overrideOperator) {
      throw new Error(
        `"${targetId}" is operator-sourced (source: ${target.source}). ` +
        'Correcting operator knowledge requires --override-operator; use it only with explicit cause.',
      );
    }
    reason = `${options.reason} [--override-operator used on operator-sourced record]`;
  }

  const source = options.source ?? 'unknown';

  if (options.supersedeBy) {
    const survivor = store.findById(options.supersedeBy);
    if (!survivor) {
      throw new Error(`Supersede target "${options.supersedeBy}" not found`);
    }
    if (survivor.id === target.id) {
      throw new Error('A memory cannot supersede itself');
    }
    if (survivor.state !== 'active') {
      throw new Error(`Supersede target "${options.supersedeBy}" is ${survivor.state}, not active`);
    }

    target.state = 'superseded';
    target.superseded_by = survivor.id;
    target.supersede_reason = reason;
    store.moveToArchive(target, 'superseded');

    return `Superseded ${targetId} → ${survivor.id} (merged into existing memory)\nReason: ${reason}`;
  }

  if (options.replace) {
    const newId = `ms_${ulid()}`;
    const now = new Date().toISOString();

    // The replacement is fresh knowledge: its check_by starts now at the
    // type default rather than inheriting whatever was left on the dying record.
    const expires = new Date();
    expires.setUTCDate(expires.getUTCDate() + decayDaysFor(target.type, store.root));

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
      supersedes: [target.id],
      supersede_reason: reason,
      title: options.title ?? target.title,
      body: options.replace,
    });

    target.state = 'superseded';
    target.superseded_by = newId;
    target.supersede_reason = reason;
    store.moveToArchive(target, 'superseded');

    return `Corrected ${targetId} → ${newId}\nReason: ${reason}`;
  }

  target.state = 'superseded';
  target.supersede_reason = reason;
  store.moveToArchive(target, 'superseded');

  return `Invalidated ${targetId}\nReason: ${reason}`;
}
