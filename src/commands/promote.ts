import { existsSync, unlinkSync } from 'node:fs';
import { loadConfig } from '../lib/config.js';
import { MemspecStore } from '../lib/store.js';

export interface PromoteOptions {
  cwd?: string;
  source?: string;
}

export function runPromote(id: string, options: PromoteOptions): string {
  const store = new MemspecStore(options.cwd);
  const config = loadConfig(store.root);
  const item = store.findById(id);

  if (!item) throw new Error(`Memory not found: ${id}`);
  if (item.state === 'active') return `Memory ${id} is already active`;
  if (item.state !== 'captured') throw new Error(`Cannot promote memory in state: ${item.state}`);

  const ext = (item.ext ?? {}) as Record<string, unknown>;
  const confirmations = ((ext.confirmations as number) ?? 0) + 1;
  const confirmedBy = [...((ext.confirmed_by as string[]) ?? [])];
  if (options.source && !confirmedBy.includes(options.source)) {
    confirmedBy.push(options.source);
  }

  const stab = config.stabilization;
  const shouldPromote = !stab.enabled ||
    confirmations >= stab.min_confirmations ||
    item.confidence >= stab.auto_promote_confidence;

  if (shouldPromote) {
    // Delete old file from observations/
    if (existsSync(item.filePath)) {
      unlinkSync(item.filePath);
    }

    // Write as active to memory/{type}s/
    const newConfidence = Math.min(1.0, item.confidence + 0.2);
    store.writeItem({
      ...item,
      state: 'active',
      confidence: newConfidence,
      ext: { ...ext, confirmations, confirmed_by: confirmedBy, promoted_at: new Date().toISOString() },
    });

    return `Promoted ${id} to active (confidence: ${newConfidence.toFixed(2)})`;
  } else {
    // Just increment confirmation count, keep as captured
    const newConfidence = Math.min(1.0, item.confidence + 0.1);
    store.updateItem({
      ...item,
      confidence: newConfidence,
      ext: { ...ext, confirmations, confirmed_by: confirmedBy },
    });

    return `Confirmed ${id} (${confirmations}/${stab.min_confirmations} confirmations, confidence: ${newConfidence.toFixed(2)})`;
  }
}
