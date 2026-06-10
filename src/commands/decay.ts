import { projectRootForStore } from '../lib/anchors.js';
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
  const candidates = findDecayCandidates(items, { projectRoot: projectRootForStore(store.root) });
  const expired = candidates.filter((c) => c.kind === 'expired');
  const drifted = candidates.filter((c) => c.kind === 'anchor-drift');

  const lines: string[] = [];

  if (expired.length === 0) {
    lines.push('No items past TTL.');
  } else {
    lines.push(`${expired.length} item(s) past TTL:`, '');
    for (const c of expired) {
      lines.push(`[${c.item.type}] ${c.item.title}`);
      lines.push(`  ${c.item.id} - ${c.reason}`);
    }
  }

  if (drifted.length > 0) {
    lines.push('', `${drifted.length} item(s) with anchor drift (review with memspec verify, correct, or anchor — not auto-archived):`, '');
    for (const c of drifted) {
      lines.push(`[${c.item.type}] ${c.item.title}`);
      lines.push(`  ${c.item.id} - ${c.reason}`);
    }
  }

  if (expired.length === 0) {
    return lines.join('\n');
  }

  if (options.dryRun) {
    lines.push('', 'Dry run - no changes made.');
    return lines.join('\n');
  }

  let decayed = 0;
  let archived = 0;

  for (const c of expired) {
    if (options.archive) {
      store.moveToArchive(c.item, 'archived');
      archived++;
    } else {
      store.moveToArchive(c.item, 'decayed');
      decayed++;
    }
  }

  lines.push('');
  if (decayed > 0) lines.push(`Decayed ${decayed} item(s).`);
  if (archived > 0) lines.push(`Archived ${archived} item(s).`);

  return lines.join('\n');
}
