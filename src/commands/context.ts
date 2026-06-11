import { getCodeAnchors } from '../lib/anchors.js';
import { loadConfig } from '../lib/config.js';
import { effectiveSourceKind } from '../lib/source.js';
import { MemspecStore } from '../lib/store.js';
import { MEMORY_TYPES, type MemoryItem, type MemoryType } from '../lib/types.js';
import { recentRetrievalCounts } from '../lib/usage.js';

export interface ContextOptions {
  cwd?: string;
  query?: string;
  type?: string;
  limit?: string;
  budget?: string;
  format?: string;
}

const DEFAULT_BUDGET_TOKENS = 2000;
const HARD_LIMIT = 20;
const BODY_PREVIEW_CHARS = 120;
const USAGE_WINDOW_DAYS = 30;

/**
 * Ranking constants — the six hand-picked numbers from FABLE §7.
 * Tuning candidates if the boot list ranking looks off in practice.
 *
 * type_weight: decisions are the most durable knowledge; procedures next;
 * facts decay fastest because code changes outpace doc updates.
 *
 * halflife_days: aligned with the v0.3 check_by defaults so freshness halves
 * at roughly the same time the stale flag would fire.
 */
const TYPE_WEIGHT: Record<MemoryType, number> = {
  decision: 1.0,
  procedure: 0.9,
  fact: 0.8,
};

const HALFLIFE_DAYS: Record<MemoryType, number> = {
  decision: 180,
  procedure: 90,
  fact: 45,
};

const USAGE_BOOST_COEFFICIENT = 0.25;

/**
 * Freshness clocks from last_verified, not created. Re-witnessed old claims
 * are fresh — that's the whole point of the witness model.
 */
export function freshness(item: MemoryItem, now: number): number {
  if (!item.type) return 0; // observations don't enter the boot list
  const halflife = HALFLIFE_DAYS[item.type];
  const witnessTs = Date.parse(item.last_verified ?? item.created);
  const ageDays = Math.max(0, (now - witnessTs) / (24 * 60 * 60 * 1000));
  return Math.exp(-Math.LN2 * ageDays / halflife);
}

/**
 * usage_boost = log2(count + 1) * 0.25 + 1. Empty usage → 1.0 (no penalty).
 * Five hits in a 30d window roughly doubles the boost; one hit nudges by
 * ~0.25.
 */
export function usageBoost(count: number): number {
  return Math.log2(count + 1) * USAGE_BOOST_COEFFICIENT + 1;
}

export function rankScore(
  item: MemoryItem,
  now: number,
  retrievalCounts: Map<string, number>,
): number {
  if (!item.type) return 0;
  return TYPE_WEIGHT[item.type] * freshness(item, now) * usageBoost(retrievalCounts.get(item.id) ?? 0);
}

function assertMemoryType(input: string): MemoryType {
  if ((MEMORY_TYPES as readonly string[]).includes(input)) {
    return input as MemoryType;
  }
  throw new Error(`Unsupported memory type: ${input}`);
}

function estimateTokens(text: string): number {
  // Standard chars/4 heuristic — good enough without a tokenizer dependency.
  return Math.ceil(text.length / 4);
}

function truncateBody(body: string, max: number = BODY_PREVIEW_CHARS): string {
  const bodyLines = body.split('\n').filter((l) => !l.startsWith('#'));
  const collapsed = bodyLines.join(' ').replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, max - 1).trimEnd() + '…';
}

function rankActive(items: MemoryItem[], now: number, retrievalCounts: Map<string, number>): MemoryItem[] {
  // Full freshness × type_weight × usage_boost formula. Replaces the simpler
  // hyperbolic recency placeholder so the boot list reflects what the
  // codebase is actually working on, not just what was touched last.
  return [...items].sort((a, b) => rankScore(b, now, retrievalCounts) - rankScore(a, now, retrievalCounts));
}

/** Witness marker: anchored claims show the anchor; everything else shows verification age. */
function witnessMarker(item: MemoryItem, now: number): string {
  if (getCodeAnchors(item).length > 0) return '⚓';
  const verified = Date.parse(item.last_verified ?? item.created);
  const days = Math.max(0, Math.floor((now - verified) / (24 * 60 * 60 * 1000)));
  return `✓${days}d`;
}

/**
 * One booted memory per line, with its id so it is immediately actionable
 * (verify/correct/anchor without a re-search to recover the handle).
 */
function formatLine(item: MemoryItem, now: number): string {
  const preview = truncateBody(item.body);
  const head = `- ${item.id} ${item.type ?? 'observation'} [${effectiveSourceKind(item)}] ${witnessMarker(item, now)}: ${item.title}`;
  return preview ? `${head} — ${preview}` : head;
}

function renderMarkdown(items: MemoryItem[]): string {
  if (items.length === 0) {
    return '## Active project memory\n\n_No active memories._\n';
  }

  const now = Date.now();
  const lines: string[] = ['## Active project memory', ''];
  for (const item of items) {
    lines.push(formatLine(item, now));
  }
  lines.push('');
  return lines.join('\n');
}

function renderJson(items: MemoryItem[]): string {
  return JSON.stringify(
    items.map((item) => ({
      id: item.id,
      type: item.type,
      title: item.title,
      verified_with: item.verified_with ?? 'assertion',
      created: item.created,
      tags: item.tags,
      source: item.source,
      body: truncateBody(item.body),
    })),
    null,
    2,
  );
}

function selectWithinBudget(items: MemoryItem[], budgetTokens: number, hardLimit: number): MemoryItem[] {
  // Greedily add items until we'd exceed the budget. Estimate token cost of
  // each item by rendering it through the same body-truncation path used by
  // the markdown formatter.
  const selected: MemoryItem[] = [];
  const now = Date.now();
  let used = estimateTokens('## Active project memory\n\n');
  for (const item of items) {
    if (selected.length >= hardLimit) break;
    const cost = estimateTokens(`${formatLine(item, now)}\n`);
    if (used + cost > budgetTokens && selected.length > 0) break;
    selected.push(item);
    used += cost;
  }
  return selected;
}

export function runContext(options: ContextOptions): string {
  const store = new MemspecStore(options.cwd);
  if (!store.exists) {
    return options.format === 'json' ? '[]' : '## Active project memory\n\n_No active memories._\n';
  }

  const explicitType = options.type ? assertMemoryType(options.type) : undefined;

  const budget = options.budget ? parseInt(options.budget, 10) : DEFAULT_BUDGET_TOKENS;
  if (Number.isNaN(budget) || budget < 1) {
    throw new Error(`Invalid budget: ${options.budget}`);
  }

  const requestedLimit = options.limit ? parseInt(options.limit, 10) : HARD_LIMIT;
  if (Number.isNaN(requestedLimit) || requestedLimit < 1) {
    throw new Error(`Invalid limit: ${options.limit}`);
  }
  const limit = Math.min(requestedLimit, HARD_LIMIT);

  const now = Date.now();
  const retrievalCounts = recentRetrievalCounts(store.root, USAGE_WINDOW_DAYS);

  let candidates: MemoryItem[];
  if (options.query) {
    const config = loadConfig(store.root);
    const profile = config.profiles.default;
    candidates = store.search(options.query, {
      limit,
      types: explicitType ? [explicitType] : undefined,
      minConfidence: 0,
      ranking: profile?.ranking,
    });
  } else {
    const active = store.loadActive();
    const filtered = explicitType ? active.filter((item) => item.type === explicitType) : active;
    candidates = rankActive(filtered, now, retrievalCounts).slice(0, limit);
  }

  const selected = selectWithinBudget(candidates, budget, limit);

  const format = options.format ?? 'markdown';
  if (format === 'json') return renderJson(selected);
  if (format !== 'markdown') throw new Error(`Unsupported format: ${format}`);
  return renderMarkdown(selected);
}
