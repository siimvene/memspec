import { MemspecStore } from '../lib/store.js';
import { findDecayCandidates } from '../lib/decay.js';

export interface DecayOptions {
  cwd?: string;
  dryRun?: boolean;
  archive?: boolean;
}

export function runDecay(options: DecayOptions): string {
  const store = new MemspecStore(options.cwd);
  const items = store.loadAll();
  const candidates = findDecayCandidates(items);

  if (candidates.length === 0) {
    return 'No items past TTL.';
  }

  const lines: string[] = [`${candidates.length} item(s) past TTL:`, ''];

  for (const c of candidates) {
    lines.push(`[${c.item.type}] ${c.item.title}`);
    lines.push(`  ${c.item.id} - ${c.reason}`);
  }

  if (options.dryRun) {
    lines.push('', 'Dry run - no changes made.');
    return lines.join('\n');
  }

  let decayed = 0;
  let archived = 0;

  for (const c of candidates) {
    if (options.archive) {
      store.moveToArchive(c.item);
      archived++;
    } else {
      c.item.state = 'decayed';
      store.updateItem(c.item);
      decayed++;
    }
  }

  lines.push('');
  if (decayed > 0) lines.push(`Decayed ${decayed} item(s).`);
  if (archived > 0) lines.push(`Archived ${archived} item(s).`);

  return lines.join('\n');
}
