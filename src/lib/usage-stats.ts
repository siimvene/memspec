import { readOutcomes } from './outcomes.js';
import { readUsageEntries } from './usage.js';

/**
 * Read-side derivations over `usage.jsonl` + `outcomes.jsonl`, per memory id.
 * Never written back to frontmatter — this is retrieval-log arithmetic, not
 * part of the record's own truth. Feeds `status`'s Cold / Promotion
 * candidates sections and the `last_referenced`/`sessions` fields surfaced on
 * search hits and `memspec_get`.
 */
export interface UsageStatsEntry {
  /** Most recent retrieval timestamp (ISO 8601), when the id has ever been retrieved. */
  last_referenced?: string;
  /** Count of distinct sessions that retrieved this id. */
  sessions: number;
  useful: number;
  dead_end: number;
  corrected: number;
}

function emptyStats(): UsageStatsEntry {
  return { sessions: 0, useful: 0, dead_end: 0, corrected: 0 };
}

/** Compute per-id usage stats for a store. Never throws. */
export function computeUsageStats(storeRoot: string): Map<string, UsageStatsEntry> {
  const stats = new Map<string, UsageStatsEntry>();
  const sessionsById = new Map<string, Set<string>>();

  for (const entry of readUsageEntries(storeRoot)) {
    if (!entry.id) continue;
    const stat = stats.get(entry.id) ?? emptyStats();
    const at = Date.parse(entry.retrieved_at);
    if (!Number.isNaN(at) && (!stat.last_referenced || at > Date.parse(stat.last_referenced))) {
      stat.last_referenced = entry.retrieved_at;
    }
    stats.set(entry.id, stat);
    if (entry.session) {
      const set = sessionsById.get(entry.id) ?? new Set<string>();
      set.add(entry.session);
      sessionsById.set(entry.id, set);
    }
  }
  for (const [id, set] of sessionsById) {
    const stat = stats.get(id);
    if (stat) stat.sessions = set.size;
  }

  for (const outcome of readOutcomes(storeRoot)) {
    if (!outcome.id) continue;
    const stat = stats.get(outcome.id) ?? emptyStats();
    if (outcome.outcome === 'useful') stat.useful++;
    else if (outcome.outcome === 'dead_end') stat.dead_end++;
    else if (outcome.outcome === 'corrected') stat.corrected++;
    stats.set(outcome.id, stat);
  }

  return stats;
}
