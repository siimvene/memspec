import { getProfile, loadConfig } from '../lib/config.js';
import { sharedTagCount, titleTokenOverlap } from '../lib/inference.js';
import { MemspecStore, type StoreSearchOptions } from '../lib/store.js';
import { MEMORY_TYPES, type MemoryItem, type MemoryType, type VerifiedWith } from '../lib/types.js';
import { recordSearchHits } from '../lib/usage.js';

export interface SearchOptions {
  cwd?: string;
  type?: string;
  limit?: string;
  json?: boolean;
  profile?: string;
  full?: boolean;
  /**
   * v0.5 Phase 2 — ISO 8601 timestamp. When set, drop results whose
   * world-state validity window doesn't contain this point. Records with no
   * `valid_from`/`valid_to` bounds are treated as always valid and always
   * returned. Orthogonal to `check_by` staleness — past `check_by` only
   * means review is overdue, past `valid_to` means the fact no longer holds.
   */
  asOf?: string;
}

/**
 * v0.5 Phase 2 — drop a record when `asOf` is set and lies outside the
 * record's validity window. Missing bounds are treated as open-ended
 * (`-Infinity` for `valid_from`, `+Infinity` for `valid_to`), so a record
 * with no validity fields is always returned. Returns `true` to keep the
 * record, `false` to drop it.
 */
export function isValidAsOf(item: MemoryItem, asOf: Date): boolean {
  if (item.valid_from !== undefined) {
    const from = Date.parse(item.valid_from);
    if (!Number.isNaN(from) && asOf.getTime() < from) return false;
  }
  if (item.valid_to !== undefined) {
    const to = Date.parse(item.valid_to);
    if (!Number.isNaN(to) && asOf.getTime() > to) return false;
  }
  return true;
}

/**
 * One result row, shared by every search consumer (CLI text, CLI JSON,
 * MCP structuredContent). The single search payload is the contract.
 */
export interface SearchResult {
  id: string;
  type: MemoryType | 'observation';
  title: string;
  verified_with: VerifiedWith;
  created: string;
  last_verified: string;
  source: string;
  tags: string[];
  stale: boolean;
  conflicts_with: string[];
  /** v0.4 typed relation edges — ids of records this hit refines/supports/depends on. */
  refines: string[];
  supports: string[];
  depends_on: string[];
  preview: string;
  body?: string; // present only when full=true and within the budget
}

export interface SearchPayload {
  query: string;
  profile: string;
  count: number;
  full: boolean;
  results: SearchResult[];
}

/**
 * Token budget for full bodies — chars/4 heuristic, no tokenizer dependency.
 * Matches the heuristic used in context.ts for consistency.
 */
const FULL_BODY_TOKEN_BUDGET = 2000;
const PREVIEW_CHARS = 160;

function assertMemoryType(input: string): MemoryType {
  if ((MEMORY_TYPES as readonly string[]).includes(input)) {
    return input as MemoryType;
  }
  throw new Error(`Unsupported memory type: ${input}`);
}

function parseProfileTypes(types?: string[]): MemoryType[] | undefined {
  if (!types || types.length === 0) return undefined;
  return types.filter((type): type is MemoryType => (MEMORY_TYPES as readonly string[]).includes(type));
}

function previewFromBody(body: string, limit = PREVIEW_CHARS): string {
  const lines = body.split('\n').filter((line) => !line.startsWith('#'));
  return lines.join(' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function witnessOf(item: MemoryItem): VerifiedWith {
  if (item.verified_with) return item.verified_with;
  if (item.anchors && item.anchors.length > 0) return 'anchor';
  return 'assertion';
}

/**
 * Cheap pairwise conflict surface within a result set: declared conflicts_with
 * is honoured directly; same-type, same-tag, overlapping-title pairs that aren't
 * already declared get added so the LLM sees the contradiction even if no
 * supersede has landed yet. Not a replacement for status conflicts — just the
 * "is this result set internally consistent?" pass.
 */
function annotateConflicts(items: MemoryItem[]): Map<string, string[]> {
  const byId = new Map(items.map((item) => [item.id, item]));
  const out = new Map<string, Set<string>>();
  for (const item of items) {
    out.set(item.id, new Set(item.conflicts_with ?? []));
  }

  for (let i = 0; i < items.length; i++) {
    const a = items[i];
    if (!a.type) continue;
    for (let j = i + 1; j < items.length; j++) {
      const b = items[j];
      if (!b.type) continue;
      if (a.type !== b.type) continue;
      // share at least one tag
      if (sharedTagCount(a.tags, b.tags) === 0) continue;
      // title token overlap >= 2 — cheap stand-in for semantic overlap
      if (titleTokenOverlap(a.title, b.title) < 2) continue;
      out.get(a.id)!.add(b.id);
      out.get(b.id)!.add(a.id);
    }
  }

  const result = new Map<string, string[]>();
  for (const [id, set] of out) {
    // Only retain conflicts pointing at items the consumer will actually see.
    const filtered = [...set].filter((cid) => byId.has(cid) || (items.find((i) => i.id === id)?.conflicts_with ?? []).includes(cid));
    result.set(id, filtered);
  }
  return result;
}

/**
 * Single search entry point. Both CLI and MCP read from this payload — no
 * second `store.search` call to keep them in sync.
 */
export function searchPayload(query: string, options: SearchOptions): SearchPayload {
  const store = new MemspecStore(options.cwd);
  const config = loadConfig(store.root);
  const profileName = options.profile ?? 'default';
  const profile = getProfile(config, profileName);

  const limit = parseInt(options.limit ?? '10', 10);
  if (Number.isNaN(limit) || limit < 1) {
    throw new Error(`Invalid limit: ${options.limit}`);
  }

  const explicitType = options.type ? assertMemoryType(options.type) : undefined;
  const types = explicitType ? [explicitType] : parseProfileTypes(profile.types);
  const storeOptions: StoreSearchOptions = {
    limit,
    types,
    minConfidence: profile.min_confidence ?? 0,
    ranking: profile.ranking,
  };
  // v0.5 Phase 2 — temporal validity filter. Parse asOf up front (before the
  // store query) so a bad ISO string fails the request loudly rather than
  // silently letting every record through (which would be the behaviour of
  // NaN comparisons).
  let asOfDate: Date | undefined;
  if (options.asOf !== undefined) {
    asOfDate = new Date(options.asOf);
    if (Number.isNaN(asOfDate.getTime())) {
      throw new Error(`Invalid as_of timestamp: ${options.asOf} (must be ISO 8601)`);
    }
  }

  let items = store.search(query, storeOptions);
  if (asOfDate !== undefined) {
    items = items.filter((item) => isValidAsOf(item, asOfDate));
  }

  const conflicts = annotateConflicts(items);
  const full = options.full === true;
  let budgetUsed = 0;

  const results: SearchResult[] = items.map((item) => {
    const result: SearchResult = {
      id: item.id,
      type: item.type ?? 'observation',
      title: item.title,
      verified_with: witnessOf(item),
      created: item.created,
      last_verified: item.last_verified ?? item.created,
      source: item.source,
      tags: item.tags,
      stale: item.stale ?? false,
      conflicts_with: conflicts.get(item.id) ?? [],
      refines: item.refines ?? [],
      supports: item.supports ?? [],
      depends_on: item.depends_on ?? [],
      preview: previewFromBody(item.body),
    };

    if (full) {
      const cost = estimateTokens(item.body);
      if (budgetUsed + cost <= FULL_BODY_TOKEN_BUDGET) {
        result.body = item.body;
        budgetUsed += cost;
      }
    }

    return result;
  });

  if (results.length > 0) {
    recordSearchHits(store.root, results.map((r) => r.id));
  }

  return {
    query,
    profile: profileName,
    count: results.length,
    full,
    results,
  };
}

/**
 * CLI text/JSON formatter. Reads the same payload the MCP returns, so the
 * structured shape and the text rendering can never drift.
 */
export function runSearch(query: string, options: SearchOptions): string {
  const payload = searchPayload(query, options);

  if (payload.results.length === 0) {
    return options.json ? '[]' : `No results for "${query}"`;
  }

  if (options.json) {
    return JSON.stringify(payload.results.map((r) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      verified_with: r.verified_with,
      created: r.created,
      last_verified: r.last_verified,
      tags: r.tags,
      source: r.source,
      stale: r.stale,
      conflicts_with: r.conflicts_with,
      refines: r.refines,
      supports: r.supports,
      depends_on: r.depends_on,
      ...(r.body !== undefined ? { body: r.body } : {}),
    })), null, 2);
  }

  const lines: string[] = [`${payload.results.length} result(s) for "${query}"`, ''];

  for (const item of payload.results) {
    const conflictTag = item.conflicts_with.length > 0 ? ` [CONFLICTS WITH ${item.conflicts_with.join(', ')}]` : '';
    lines.push(`[${item.type}] ${item.title} (${item.verified_with})${item.stale ? ' [STALE — verify or supersede before relying on this]' : ''}${conflictTag}`);
    lines.push(`  ${item.id} | ${item.created.substring(0, 10)} | ${item.source}`);
    if (item.tags.length > 0) {
      lines.push(`  tags: ${item.tags.join(', ')}`);
    }
    if (item.body !== undefined) {
      lines.push(`  ${item.body.split('\n').filter((l) => !l.startsWith('#')).join(' ').trim()}`);
    } else if (item.preview) {
      lines.push(`  ${item.preview.slice(0, 120)}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
