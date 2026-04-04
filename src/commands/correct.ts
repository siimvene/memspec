import { ulid } from 'ulid';
import { MemspecStore } from '../lib/store.js';

export interface CorrectOptions {
  cwd?: string;
  reason: string;
  replace?: string;
  source?: string;
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

  const source = options.source ?? 'unknown';

  if (options.replace) {
    const newId = `ms_${ulid()}`;
    const now = new Date().toISOString();

    store.writeItem({
      id: newId,
      type: target.type,
      state: 'active',
      confidence: 0.8,
      created: now,
      source,
      tags: target.tags,
      decay_after: target.decay_after,
      corrects: target.id,
      title: target.title,
      body: options.replace,
    });

    target.state = 'corrected';
    target.corrected_by = newId;
    store.updateItem(target);

    return `Corrected ${targetId} → ${newId}\nReason: ${options.reason}`;
  }

  target.state = 'corrected';
  store.updateItem(target);

  return `Invalidated ${targetId}\nReason: ${options.reason}`;
}
