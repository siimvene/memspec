import { createInterface } from 'node:readline/promises';
import { MemspecStore } from '../lib/store.js';

export interface SweepOptions {
  cwd?: string;
  dryRun?: boolean;
}

/**
 * Physically retire stale-flagged items, one interactive prompt per candidate.
 * Deliberately CLI-only: removal is an operator act, not an agent surface.
 */
export async function runSweep(options: SweepOptions): Promise<string> {
  const store = new MemspecStore(options.cwd);
  const candidates = store.loadActive().filter((item) => item.stale === true);

  if (candidates.length === 0) {
    return 'No stale items to sweep.';
  }

  if (options.dryRun) {
    const lines = [`${candidates.length} stale item(s) eligible for retirement:`, ''];
    for (const item of candidates) {
      lines.push(`[${item.type ?? 'observation'}] ${item.title}`);
      lines.push(`  ${item.id} | source: ${item.source} | check_by: ${item.check_by}`);
    }
    lines.push('', 'Dry run - no changes made.');
    return lines.join('\n');
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let retired = 0;
  let seen = 0;
  try {
    for (const item of candidates) {
      seen++;
      console.log(`\n[${item.type ?? 'observation'}] ${item.title}`);
      console.log(`  ${item.id} | source: ${item.source} | check_by: ${item.check_by}`);
      let answer: string;
      try {
        answer = (await rl.question('Retire this item? [y/N/q] ')).trim().toLowerCase();
      } catch {
        break; // stdin closed mid-prompt — stop, retire nothing further
      }
      if (answer === 'q') break;
      if (answer === 'y' || answer === 'yes') {
        store.moveToArchive(item, 'retired');
        retired++;
      }
    }
  } finally {
    rl.close();
  }

  return `Retired ${retired} of ${candidates.length} stale item(s) (${seen} reviewed).`;
}
