import { projectRootForStore } from '../lib/anchors.js';
import { MemspecStore } from '../lib/store.js';
import { findDecayCandidates } from '../lib/decay.js';

export interface DecayOptions {
  cwd?: string;
  dryRun?: boolean;
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
      lines.push(`[${c.item.type}] ${c.item.title}${c.item.stale ? ' (already flagged stale)' : ''}`);
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

  // Expiry flags, never deletes: stale items stay active and searchable,
  // marked for review. Physical retirement is `memspec sweep`, operator-run.
  const fresh = expired.filter((c) => !c.item.stale);
  for (const c of fresh) {
    c.item.stale = true;
    store.updateItem(c.item);
  }

  lines.push('');
  lines.push(`Flagged ${fresh.length} item(s) stale.`);
  if (expired.length > fresh.length) {
    lines.push(`${expired.length - fresh.length} item(s) were already flagged.`);
  }
  lines.push('Stale items stay searchable; run `memspec sweep` to retire them interactively.');

  return lines.join('\n');
}
