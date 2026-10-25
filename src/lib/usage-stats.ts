import { closeSync, openSync, readSync, statSync, type Stats } from 'node:fs';
import { outcomesPath, readOutcomes, type OutcomeEntry } from './outcomes.js';
import { usagePath, type UsageEntry } from './usage.js';

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

/** Per-id fold of the usage log: what `computeUsageStats` needs, nothing more. */
interface UsageFold {
  lastReferenced: Map<string, { iso: string; ms: number } | undefined>;
  sessions: Map<string, Set<string>>;
}

/**
 * Incremental fold of one store's `usage.jsonl`. Every search appends to the
 * log and every search reads it back, so re-parsing the whole file per query
 * grew linearly with history (~30 ms at 33k rows). The log is append-only:
 * while the file keeps its inode and the bytes before `offset` are unchanged
 * (checked on a short probe), only the bytes after `offset` are read. Any
 * other change (rotated, truncated, rewritten) refolds from the start.
 */
interface UsageCursor {
  ino: number;
  /** Bytes folded so far, always just past a newline. */
  offset: number;
  /** The last bytes before `offset`, compared on the next read to detect a rewrite. */
  probe: Buffer;
  fold: UsageFold;
}

const PROBE_BYTES = 64;
const usageCursors = new Map<string, UsageCursor>();
const outcomesCache = new Map<string, { key: string; entries: OutcomeEntry[] }>();

function newFold(): UsageFold {
  return { lastReferenced: new Map(), sessions: new Map() };
}

/** Fold one usage row, with exactly the semantics of the original full-file pass. */
function foldEntry(fold: UsageFold, entry: UsageEntry): void {
  if (!entry || !entry.id) return;
  const at = Date.parse(entry.retrieved_at);
  const current = fold.lastReferenced.get(entry.id);
  if (!Number.isNaN(at) && (!current || at > current.ms)) {
    fold.lastReferenced.set(entry.id, { iso: entry.retrieved_at, ms: at });
  } else if (!fold.lastReferenced.has(entry.id)) {
    fold.lastReferenced.set(entry.id, undefined);
  }
  if (entry.session) {
    const set = fold.sessions.get(entry.id) ?? new Set<string>();
    set.add(entry.session);
    fold.sessions.set(entry.id, set);
  }
}

function parseLine(line: string): UsageEntry | null {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line) as UsageEntry;
  } catch {
    return null; // skip malformed lines silently
  }
}

function readRange(path: string, start: number, end: number): Buffer {
  const buf = Buffer.alloc(end - start);
  const fd = openSync(path, 'r');
  try {
    let read = 0;
    while (read < buf.length) {
      const n = readSync(fd, buf, read, buf.length - read, start + read);
      if (n === 0) break;
      read += n;
    }
    return read === buf.length ? buf : buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/**
 * The usage fold for `storeRoot`, plus the rows of a trailing line that has
 * no newline yet (folded into this call's answer only, never into the cursor,
 * since an appender may still be writing it).
 */
function usageFoldFor(storeRoot: string): { fold: UsageFold; pending: UsageEntry[] } {
  const path = usagePath(storeRoot);
  let st: Stats | undefined;
  try {
    st = statSync(path, { throwIfNoEntry: false });
  } catch {
    st = undefined;
  }
  if (!st) {
    usageCursors.delete(path);
    return { fold: newFold(), pending: [] };
  }

  try {
    let cursor = usageCursors.get(path);
    if (cursor && (cursor.ino !== st.ino || st.size < cursor.offset)) cursor = undefined;
    if (cursor && cursor.probe.length > 0) {
      const probe = readRange(path, cursor.offset - cursor.probe.length, cursor.offset);
      if (!probe.equals(cursor.probe)) cursor = undefined;
    }
    if (!cursor) cursor = { ino: st.ino, offset: 0, probe: Buffer.alloc(0), fold: newFold() };

    const pending: UsageEntry[] = [];
    if (st.size > cursor.offset) {
      const chunk = readRange(path, cursor.offset, st.size);
      const lastNewline = chunk.lastIndexOf(0x0a);
      const complete = lastNewline >= 0 ? chunk.subarray(0, lastNewline + 1) : chunk.subarray(0, 0);
      for (const line of complete.toString('utf8').split('\n')) {
        const entry = parseLine(line);
        if (entry) foldEntry(cursor.fold, entry);
      }
      const tail = parseLine(chunk.subarray(lastNewline + 1).toString('utf8'));
      if (tail) pending.push(tail);
      if (complete.length > 0) {
        cursor.offset += complete.length;
        const probeStart = Math.max(0, complete.length - PROBE_BYTES);
        cursor.probe = Buffer.from(complete.subarray(probeStart));
      }
    }
    usageCursors.set(path, cursor);
    return { fold: cursor.fold, pending };
  } catch {
    usageCursors.delete(path);
    return { fold: newFold(), pending: [] };
  }
}

/** Outcome rows, re-read only when the file's (inode, size, mtime) changes. */
function outcomesFor(storeRoot: string): OutcomeEntry[] {
  const path = outcomesPath(storeRoot);
  let key = 'absent';
  try {
    const st = statSync(path, { throwIfNoEntry: false });
    if (st) key = `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
  } catch {
    key = 'unreadable';
  }
  const cached = outcomesCache.get(path);
  if (cached && cached.key === key) return cached.entries;
  const entries = readOutcomes(storeRoot);
  outcomesCache.set(path, { key, entries });
  return entries;
}

/**
 * Compute per-id usage stats for a store. Never throws. The usage log is
 * folded incrementally across calls in one process (see `UsageCursor`); the
 * returned map and its entries are fresh on every call.
 */
export function computeUsageStats(storeRoot: string): Map<string, UsageStatsEntry> {
  const stats = new Map<string, UsageStatsEntry>();
  const { fold: committed, pending } = usageFoldFor(storeRoot);
  let fold = committed;
  if (pending.length > 0) {
    // Apply the unterminated last line to a copy, so the cursor never holds it.
    fold = {
      lastReferenced: new Map(committed.lastReferenced),
      sessions: new Map([...committed.sessions].map(([id, set]) => [id, new Set(set)])),
    };
    for (const entry of pending) foldEntry(fold, entry);
  }

  for (const [id, last] of fold.lastReferenced) {
    const stat = emptyStats();
    if (last) stat.last_referenced = last.iso;
    stat.sessions = fold.sessions.get(id)?.size ?? 0;
    stats.set(id, stat);
  }

  for (const outcome of outcomesFor(storeRoot)) {
    if (!outcome.id) continue;
    const stat = stats.get(outcome.id) ?? emptyStats();
    if (outcome.outcome === 'useful') stat.useful++;
    else if (outcome.outcome === 'dead_end') stat.dead_end++;
    else if (outcome.outcome === 'corrected') stat.corrected++;
    stats.set(outcome.id, stat);
  }

  return stats;
}
