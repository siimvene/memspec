import { createInterface } from 'node:readline/promises';
import { readFile } from 'node:fs/promises';
import { MemspecStore } from '../lib/store.js';

export interface SweepOptions {
  cwd?: string;
  dryRun?: boolean;
  /**
   * Path to a file with one `<id> <y|n>` line (tab- or space-separated) per
   * stale candidate — a non-interactive alternative to the stdin prompt loop.
   * Ids missing from the file default to 'n' (kept); unparsable lines and ids
   * matching no candidate are reported as warnings. Ignored when `dryRun` is set.
   */
  answers?: string;
}

/**
 * Parse `<id> <y|n>` lines (any whitespace separator — tab or spaces) into an
 * id → answer map. Blank lines skipped. A line that is not exactly two fields
 * with a `y|yes|n|no` answer is reported in `warnings`, never silently treated
 * as `n`: an answers file written with spaces used to parse every id as
 * `<id> y` and retire nothing.
 */
function parseAnswers(raw: string): { answers: Map<string, string>; warnings: string[] } {
  const answers = new Map<string, string>();
  const warnings: string[] = [];
  raw.split('\n').forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const fields = trimmed.split(/\s+/);
    const answer = (fields[1] ?? '').toLowerCase();
    if (fields.length !== 2 || !['y', 'yes', 'n', 'no'].includes(answer)) {
      warnings.push(`line ${index + 1} ignored (expected "<id> <y|n>"): ${trimmed}`);
      return;
    }
    answers.set(fields[0], answer);
  });
  return { answers, warnings };
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
    const { answers, warnings } = parseAnswers(raw);
    const lines: string[] = [];
    const candidateIds = new Set(candidates.map((item) => item.id));
    for (const id of answers.keys()) {
      if (!candidateIds.has(id)) warnings.push(`${id} matches no stale candidate — ignored`);
    }
    for (const warning of warnings) lines.push(`WARNING: ${warning}`);
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
