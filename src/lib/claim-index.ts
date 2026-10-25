import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseMemoryFile } from './frontmatter.js';
import { claimTokens, tokenWeight } from './similarity.js';
import type { MemspecStore } from './store.js';
import type { MemoryItem } from './types.js';

/**
 * The fields `remember`'s near-duplicate and tombstone checks read from every
 * record in a store (active and archived), plus the record's similarity tokens.
 *
 * Why a cache: both checks compare the incoming claim against EVERY same-type
 * record, archive included. Parsing and tokenizing ~4k real records costs
 * ~350 ms per write (measured), on top of the parse `search` already does.
 * The markdown files stay canonical: this is a derived, machine-local file
 * (`local/` is gitignored) keyed by each record file's path, mtime and size.
 * A changed, added or removed file is re-read on the next call, a missing or
 * corrupt cache is rebuilt, and deleting it loses nothing.
 */
export interface ClaimIndexEntry {
  id: string;
  kind: MemoryItem['kind'];
  type?: MemoryItem['type'];
  state: MemoryItem['state'];
  scope?: string;
  title: string;
  superseded_by?: string;
  supersede_reason?: string;
  tokens: string[];
  weight: number;
}

/** A file that did not parse is cached too (`invalid`), so it is not re-read on every call. */
type CachedEntry = (ClaimIndexEntry & { invalid?: undefined } | { invalid: true }) & {
  mtimeMs: number;
  size: number;
};

/** Bump when the token rules or the entry shape change: an old cache is then discarded whole. */
const CLAIM_INDEX_VERSION = 1;

export function claimIndexPath(storeRoot: string): string {
  return join(storeRoot, 'local', 'cache', 'claim-index.json');
}

function readCache(path: string): Map<string, CachedEntry> {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { version?: number; files?: Record<string, CachedEntry> };
    if (parsed.version !== CLAIM_INDEX_VERSION || !parsed.files) return new Map();
    return new Map(Object.entries(parsed.files));
  } catch {
    return new Map();
  }
}

function entryFor(item: MemoryItem): ClaimIndexEntry {
  const tokens = [...claimTokens(item.title, item.body)];
  const entry: ClaimIndexEntry = {
    id: item.id,
    kind: item.kind,
    state: item.state,
    title: item.title,
    tokens,
    weight: tokenWeight(tokens),
  };
  if (item.type) entry.type = item.type;
  if (item.scope) entry.scope = item.scope;
  if (item.superseded_by) entry.superseded_by = item.superseded_by;
  if (item.supersede_reason) entry.supersede_reason = item.supersede_reason;
  return entry;
}

/**
 * Every record in the store (memory/, observations/, archive/) as index
 * entries. A file that does not parse is skipped, as `loadAll` skips it.
 * Never throws for a cache problem: an unreadable or unwritable cache only
 * costs the rebuild.
 */
export function loadClaimIndex(store: MemspecStore): ClaimIndexEntry[] {
  const path = claimIndexPath(store.root);
  const cached = readCache(path);
  const next: Record<string, CachedEntry> = {};
  const entries: ClaimIndexEntry[] = [];
  let changed = false;

  for (const file of store.recordFiles()) {
    let stat;
    try {
      stat = statSync(file);
    } catch {
      continue;
    }
    const hit = cached.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
      next[file] = hit;
      if (!hit.invalid) entries.push(hit);
      continue;
    }
    changed = true;
    try {
      const entry = { ...entryFor(parseMemoryFile(readFileSync(file, 'utf8'), file)), mtimeMs: stat.mtimeMs, size: stat.size };
      next[file] = entry;
      entries.push(entry);
    } catch {
      // Invalid record: loadAll skips it too.
      next[file] = { invalid: true, mtimeMs: stat.mtimeMs, size: stat.size };
    }
  }
  if (changed || cached.size !== Object.keys(next).length) {
    try {
      mkdirSync(join(store.root, 'local', 'cache'), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: CLAIM_INDEX_VERSION, files: next }));
      renameSync(tmp, path);
    } catch {
      // Read-only or full disk: the next call rebuilds.
    }
  }
  return entries;
}
