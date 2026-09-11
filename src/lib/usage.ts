import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CompositeStore } from './composite-store.js';

/**
 * Per-store retrieval log. One line per result returned by a search call.
 * Read by the boot renderer to compute `usage_boost` — memories retrieved
 * often in the last 30 days surface higher in main-list ranking. Also feeds
 * `usage-stats.ts` (last_referenced, distinct sessions) for the Cold /
 * Promotion candidates surfaces in `status`.
 *
 * Local-only by design; gitignored. Append-only JSONL keeps writes cheap.
 * Rows written before v0.11 carry only `id`/`retrieved_at` — every consumer
 * must treat the new fields as optional.
 */

export type UsageSurface = 'cli' | 'mcp' | 'context' | 'hook';

export interface UsageEntry {
  id: string;
  retrieved_at: string; // ISO 8601
  /** v0.11 — the search query that produced this hit, truncated to 200 chars. */
  query?: string;
  /**
   * v0.11 — session identifier: `MEMSPEC_SESSION_ID` > `CLAUDE_SESSION_ID` >
   * the process-level label the MCP server registers (`mcp:<pid>`). ABSENT
   * when none of those applies (a bare CLI invocation): a row without a
   * session never counts towards `sessions`, so Promotion candidates require
   * a real session id rather than counting invocations.
   */
  session?: string;
  /** v0.11 — 1-based position of this hit within its result set. */
  rank?: number;
  /** v0.11 — which surface issued the search that produced this hit. */
  surface?: UsageSurface;
}

const QUERY_TRUNCATE_CHARS = 200;

/**
 * Process-level session label, registered by a long-lived process that IS a
 * session — the MCP server (one process per client connection, labelled
 * `mcp:<pid>`). Never generated on demand: a CLI process is one invocation,
 * and stamping each with a fresh id made two `memspec search` calls from the
 * same agent turn read as "retrieved in 2 distinct sessions".
 */
let processSessionLabel: string | undefined;

/** Register the label a long-lived process (the MCP server) reports as its session. */
export function setProcessSessionLabel(label: string | undefined): void {
  processSessionLabel = label;
}

/**
 * Resolve the active session id: `MEMSPEC_SESSION_ID` takes priority (lets a
 * caller stitch multiple processes into one logical session), then
 * `CLAUDE_SESSION_ID` (set by the Claude Code harness), then the label the
 * MCP server registered for itself. Returns undefined — and the usage row
 * carries no `session` — when none applies. There is deliberately no
 * per-process fallback: an id that changes on every invocation is not a
 * session, and the CLI's parent pid is the harness's per-call shell, so it
 * would be no better.
 */
export function resolveSessionId(): string | undefined {
  if (process.env.MEMSPEC_SESSION_ID) return process.env.MEMSPEC_SESSION_ID;
  if (process.env.CLAUDE_SESSION_ID) return process.env.CLAUDE_SESSION_ID;
  return processSessionLabel;
}

export function usagePath(storeRoot: string): string {
  return join(storeRoot, 'usage.jsonl');
}

export interface RecordSearchHitsOptions {
  /** Search query that produced these hits, truncated to 200 chars. */
  query?: string;
  /** Which surface issued the search. Defaults to omitted (pre-v0.11 shape) when not given. */
  surface?: UsageSurface;
  /** Override the resolved session id (mainly for tests). Defaults to `resolveSessionId()`. */
  session?: string;
}

/**
 * Append one entry per result hit, in rank order (1-based). Errors are
 * swallowed — usage log loss is non-fatal.
 */
export function recordSearchHits(storeRoot: string, ids: string[], options: RecordSearchHitsOptions = {}): void {
  if (ids.length === 0) return;
  try {
    const path = usagePath(storeRoot);
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    const session = options.session ?? resolveSessionId();
    const query = options.query !== undefined ? options.query.slice(0, QUERY_TRUNCATE_CHARS) : undefined;
    const lines = ids.map((id, index) => {
      const entry: UsageEntry = { id, retrieved_at: now, rank: index + 1 };
      if (session !== undefined) entry.session = session;
      if (query !== undefined) entry.query = query;
      if (options.surface !== undefined) entry.surface = options.surface;
      return JSON.stringify(entry);
    }).join('\n');
    appendFileSync(path, `${lines}\n`, 'utf8');
  } catch {
    // best-effort log — never fail the search
  }
}

/**
 * Log surfaced hits to the store layer that OWNS each record, not to the
 * primary alone. A record served from a read-only team layer through a
 * layered view used to be logged only into the personal store's usage.jsonl,
 * so `status` run against the team store itself reported it Cold minutes
 * after it was retrieved. Items are grouped by their read-time `layer` stamp
 * (absent = primary); rank is the item's position within its own layer's
 * group. Unknown layer names fall back to the primary root.
 */
export function recordSurfacedHitsByLayer(
  composite: CompositeStore,
  items: Array<{ id: string; layer?: string }>,
  options: RecordSearchHitsOptions = {},
): void {
  if (items.length === 0) return;
  const byRoot = new Map<string, string[]>();
  for (const item of items) {
    const root = (item.layer ? composite.getLayer(item.layer)?.store.root : undefined) ?? composite.root;
    const ids = byRoot.get(root) ?? [];
    ids.push(item.id);
    byRoot.set(root, ids);
  }
  for (const [root, ids] of byRoot) recordSearchHits(root, ids, options);
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

/** Read every well-formed row of the usage log. Never throws; empty on any failure. */
export function readUsageEntries(storeRoot: string): UsageEntry[] {
  const path = usagePath(storeRoot);
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, 'utf8');
    const out: UsageEntry[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as UsageEntry);
      } catch {
        // skip malformed lines silently
      }
    }
    return out;
  } catch {
    return [];
  }
}
