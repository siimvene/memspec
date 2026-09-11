import { createInterface } from 'node:readline/promises';
import { readFile } from 'node:fs/promises';
import { MemspecStore } from '../lib/store.js';

export interface SweepOptions {
  cwd?: string;
  dryRun?: boolean;
  /**
   * Path to a file with one `<id>\t<y|n>` line per stale candidate — a
   * non-interactive alternative to the stdin prompt loop. Ids missing from
   * the file default to 'n' (kept). Ignored when `dryRun` is set.
   */
  answers?: string;
}

/** Parse `<id>\t<y|n>` lines into an id → answer map. Blank lines skipped. */
function parseAnswers(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [id, answer] = trimmed.split('\t');
    if (id) map.set(id.trim(), (answer ?? '').trim().toLowerCase());
  }
  return map;
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

  if (options.answers) {
    const raw = await readFile(options.answers, 'utf8');
    const answers = parseAnswers(raw);
    const lines: string[] = [];
    let retired = 0;
    for (const item of candidates) {
      lines.push(`\n[${item.type ?? 'observation'}] ${item.title}`);
      lines.push(`  ${item.id} | source: ${item.source} | check_by: ${item.check_by}`);
      const answer = answers.get(item.id) ?? 'n';
      if (answer === 'y' || answer === 'yes') {
        store.moveToArchive(item, 'retired');
        retired++;
      }
    }
    lines.push(`\nRetired ${retired} of ${candidates.length} stale item(s) (${candidates.length} reviewed).`);
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
