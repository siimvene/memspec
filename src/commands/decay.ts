import { projectRootForStore } from '../lib/anchors.js';
import { MemspecStore } from '../lib/store.js';
import { findDecayCandidates } from '../lib/decay.js';

export interface DecayOptions {
  cwd?: string;
  dryRun?: boolean;
}

/**
 * Deprecated in v0.3. Stale flagging is now automatic at read time
 * (`store.loadActive()` lazily marks items past `check_by`), and physical
 * retirement is `memspec sweep`. This command is kept on the CLI as a
 * read-only summary for one release cycle; it never mutates the store.
 */
export function runDecay(options: DecayOptions): string {
  const store = new MemspecStore(options.cwd);
  const items = store.loadAll();
  const candidates = findDecayCandidates(items, { projectRoot: projectRootForStore(store.root) });
  const expired = candidates.filter((c) => c.kind === 'expired');
  const drifted = candidates.filter((c) => c.kind === 'anchor-drift');

  const lines: string[] = [
    'memspec decay is deprecated in v0.3. Stale flagging is automatic at read time;',
    'use `memspec status` to view stale and drifted items, `memspec sweep` to retire them.',
    '',
  ];

  if (expired.length === 0) {
    lines.push('No items past TTL.');
  } else {
    lines.push(`${expired.length} item(s) past TTL (flagged stale at read):`, '');
    for (const c of expired) {
      lines.push(`[${c.item.type ?? 'observation'}] ${c.item.title}`);
      lines.push(`  ${c.item.id} - ${c.reason}`);
    }
  }

  if (drifted.length > 0) {
    lines.push('', `${drifted.length} item(s) with anchor drift (review with verify, supersede, or anchor):`, '');
    for (const c of drifted) {
      lines.push(`[${c.item.type ?? 'observation'}] ${c.item.title}`);
      lines.push(`  ${c.item.id} - ${c.reason}`);
    }
  }

  return lines.join('\n');
}
