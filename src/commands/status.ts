import { projectRootForStore } from '../lib/anchors.js';
import { MemspecStore } from '../lib/store.js';
import { findDecayCandidates } from '../lib/decay.js';

export interface StatusOptions {
  cwd?: string;
}

export function runStatus(options: StatusOptions): string {
  const store = new MemspecStore(options.cwd);
  const items = store.loadAll();

  const byType: Record<string, number> = {};
  const byState: Record<string, number> = {};

  for (const item of items) {
    byState[item.state] = (byState[item.state] ?? 0) + 1;
    if (item.state === 'active' && item.type) {
      byType[item.type] = (byType[item.type] ?? 0) + 1;
    }
  }

  const lines: string[] = [`Memspec Store: ${store.root}`, ''];

  lines.push('Active:');
  for (const type of ['fact', 'decision', 'procedure']) {
    const count = byType[type] ?? 0;
    lines.push(`  ${type.padEnd(12)} ${String(count).padStart(4)}`);
  }
  lines.push('');

  lines.push('By state:');
  for (const state of ['active', 'superseded', 'retired']) {
    const count = byState[state] ?? 0;
    if (count > 0) lines.push(`  ${state.padEnd(12)} ${String(count).padStart(4)}`);
  }
  lines.push(`  ${'total'.padEnd(12)} ${String(items.length).padStart(4)}`);
  lines.push('');

  const candidates = findDecayCandidates(items, { projectRoot: projectRootForStore(store.root) });
  const decaying = candidates.filter((c) => c.kind === 'expired');
  const drifted = candidates.filter((c) => c.kind === 'anchor-drift');
  if (decaying.length > 0) {
    lines.push(`${decaying.length} item(s) past TTL:`);
    for (const c of decaying.slice(0, 5)) {
      lines.push(`  ${c.item.id} - ${c.item.title} (${c.reason})`);
    }
    if (decaying.length > 5) lines.push(`  ... and ${decaying.length - 5} more`);
  } else {
    lines.push('No items past TTL.');
  }

  if (drifted.length > 0) {
    lines.push('', `${drifted.length} item(s) with anchor drift:`);
    for (const c of drifted.slice(0, 5)) {
      lines.push(`  ${c.item.id} - ${c.item.title} (${c.reason})`);
    }
    if (drifted.length > 5) lines.push(`  ... and ${drifted.length - 5} more`);
  }

  const recent = items
    .filter((i) => i.state === 'active')
    .sort((a, b) => Date.parse(b.created) - Date.parse(a.created))
    .slice(0, 5);

  if (recent.length > 0) {
    lines.push('', 'Recent:');
    for (const item of recent) {
      lines.push(`  ${item.created.substring(0, 10)} [${item.type}] ${item.title}`);
    }
  }

  if (store.warnings.length > 0) {
    lines.push('', `Skipped ${store.warnings.length} non-memspec file(s):`);
    for (const w of store.warnings.slice(0, 5)) {
      lines.push(`  ${w.file}`);
    }
    if (store.warnings.length > 5) {
      lines.push(`  ... and ${store.warnings.length - 5} more`);
    }
  }

  return lines.join('\n');
}
