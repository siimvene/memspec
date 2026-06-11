import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Per-store retrieval log. One line per result returned by a search call.
 * Read by the boot renderer to compute `usage_boost` — memories retrieved
 * often in the last 30 days surface higher in main-list ranking.
 *
 * Local-only by design; gitignored. Append-only JSONL keeps writes cheap.
 */

export interface UsageEntry {
  id: string;
  retrieved_at: string; // ISO 8601
}

export function usagePath(storeRoot: string): string {
  return join(storeRoot, 'usage.jsonl');
}

/** Append one entry per result hit. Errors are swallowed — usage log loss is non-fatal. */
export function recordSearchHits(storeRoot: string, ids: string[]): void {
  if (ids.length === 0) return;
  try {
    const path = usagePath(storeRoot);
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    const lines = ids.map((id) => JSON.stringify({ id, retrieved_at: now } satisfies UsageEntry)).join('\n');
    appendFileSync(path, `${lines}\n`, 'utf8');
  } catch {
    // best-effort log — never fail the search
  }
}

/**
 * Count retrievals per id in the last `days` days. Returns an empty map if the
 * log doesn't exist or is unreadable.
 */
export function recentRetrievalCounts(storeRoot: string, days: number): Map<string, number> {
  const counts = new Map<string, number>();
  const path = usagePath(storeRoot);
  if (!existsSync(path)) return counts;
  try {
    const raw = readFileSync(path, 'utf8');
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as UsageEntry;
        const at = Date.parse(entry.retrieved_at);
        if (Number.isNaN(at) || at < cutoff) continue;
        counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1);
      } catch {
        // skip malformed lines silently
      }
    }
  } catch {
    // unreadable log → empty map
  }
  return counts;
}
