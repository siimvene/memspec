import { ulid } from 'ulid';
import { getDecayDays, loadConfig } from '../lib/config.js';
import { MemspecStore } from '../lib/store.js';

export interface CorrectOptions {
  cwd?: string;
  reason: string;
  replace?: string;
  title?: string;
  supersedeBy?: string;
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

  if (options.replace && options.supersedeBy) {
    throw new Error('--replace and --supersede-by are mutually exclusive');
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

    target.state = 'corrected';
    target.corrected_by = survivor.id;
    target.correction_reason = options.reason;
    store.moveToArchive(target, 'corrected');

    return `Superseded ${targetId} → ${survivor.id} (merged into existing memory)\nReason: ${options.reason}`;
  }

  if (options.replace) {
    const newId = `ms_${ulid()}`;
    const now = new Date().toISOString();

    // The replacement is fresh knowledge: its decay clock starts now at the
    // type default rather than inheriting whatever was left on the dying record.
    const config = loadConfig(store.root);
    const expires = new Date();
    expires.setUTCDate(expires.getUTCDate() + getDecayDays(config, target.type));

    store.writeItem({
      id: newId,
      type: target.type,
      state: 'active',
      confidence: 0.8,
      created: now,
      source,
      tags: target.tags,
      decay_after: expires.toISOString(),
      last_verified: now,
      corrects: target.id,
      correction_reason: options.reason,
      title: options.title ?? target.title,
      body: options.replace,
    });

    target.state = 'corrected';
    target.corrected_by = newId;
    target.correction_reason = options.reason;
    store.moveToArchive(target, 'corrected');

    return `Corrected ${targetId} → ${newId}\nReason: ${options.reason}`;
  }

  target.state = 'corrected';
  target.correction_reason = options.reason;
  store.moveToArchive(target, 'corrected');

  return `Invalidated ${targetId}\nReason: ${options.reason}`;
}
