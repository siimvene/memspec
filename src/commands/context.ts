import { checkAnchors, getCodeAnchors, projectRootForStore } from '../lib/anchors.js';
import { CompositeStore } from '../lib/composite-store.js';
import { loadConfig } from '../lib/config.js';
import { effectiveSourceKind } from '../lib/source.js';
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
const PINNED_CAP = 5;
const ATTENTION_CAP = 3;

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

/** Witness marker: stale flags first, anchored claims next, everything else shows verification age. */
function witnessMarker(item: MemoryItem, now: number): string {
  if (item.stale) return '⚠';
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

/** One needs-attention entry: the claim plus what is wrong and what to do about it. */
interface AttentionEntry {
  item: MemoryItem;
  note: string;    // e.g. "anchor drift: src/auth/oauth.ts" or "check-by passed 12d ago"
  actions: string; // "verify | supersede | anchor" for drift; "verify | supersede" for stale
}

interface Sections {
  attention: AttentionEntry[];
  pinned: MemoryItem[];
  main: MemoryItem[];
}

/**
 * Stale claims and drifted anchors — boot is where the maintenance loop
 * starts. Returns every flagged claim (the boot cap is applied at budget
 * time; the full count feeds the header). Drift takes precedence per item
 * (it names the file and unlocks the anchor action); drifted entries sort
 * ahead of stale, stale entries by how long the check-by has been overdue.
 */
function findNeedsAttention(
  items: MemoryItem[],
  projectRoot: string,
  repoSearchPaths: string[],
  now: number,
): AttentionEntry[] {
  const drifted: AttentionEntry[] = [];
  const stale: Array<AttentionEntry & { overdueDays: number }> = [];

  for (const item of items) {
    const anchors = getCodeAnchors(item);
    if (anchors.length > 0) {
      const bad = checkAnchors(projectRoot, anchors, { repoSearchPaths }).filter(
        (a) => a.status !== 'unchanged',
      );
      if (bad.length > 0) {
        drifted.push({
          item,
          note: `anchor drift: ${bad.map((a) => a.file).join(', ')}`,
          actions: 'verify | supersede | anchor',
        });
        continue;
      }
    }
    if (item.stale) {
      const checkBy = item.check_by !== 'never' ? Date.parse(item.check_by) : NaN;
      const overdueDays = Number.isNaN(checkBy)
        ? 0
        : Math.max(0, Math.floor((now - checkBy) / (24 * 60 * 60 * 1000)));
      const note = Number.isNaN(checkBy) ? 'flagged stale' : `check-by passed ${overdueDays}d ago`;
      stale.push({ item, note, actions: 'verify | supersede', overdueDays });
    }
  }

  stale.sort((a, b) => b.overdueDays - a.overdueDays);
  return [...drifted, ...stale];
}

function formatAttentionLine(entry: AttentionEntry): string {
  const { item } = entry;
  return `- ${item.id} ${item.type ?? 'observation'} ⚠ ${entry.note} — "${item.title}" → ${entry.actions}`;
}

/**
 * Take pinned items out of the main list and surface them at the top of the
 * boot context. Cap at 5; if more than 5 are pinned, take the 5 most-recently
 * verified (operator intent + freshness as the tiebreaker).
 */
function partitionPinned(items: MemoryItem[]): { pinned: MemoryItem[]; main: MemoryItem[] } {
  const allPinned = items.filter((i) => i.pinned === true);
  allPinned.sort((a, b) => {
    const av = Date.parse(a.last_verified ?? a.created);
    const bv = Date.parse(b.last_verified ?? b.created);
    return bv - av;
  });
  const pinned = allPinned.slice(0, PINNED_CAP);
  const pinnedIds = new Set(pinned.map((i) => i.id));
  const main = items.filter((i) => !pinnedIds.has(i.id));
  return { pinned, main };
}

function renderMarkdown(sections: Sections, header: string, now: number): string {
  const empty =
    sections.attention.length === 0 && sections.pinned.length === 0 && sections.main.length === 0;
  if (empty) {
    return `${header}\n\n_No active memories._\n`;
  }

  const lines: string[] = [header, ''];
  const sectioned = sections.attention.length > 0 || sections.pinned.length > 0;

  if (sections.attention.length > 0) {
    lines.push('### Needs attention');
    for (const entry of sections.attention) lines.push(formatAttentionLine(entry));
    lines.push('');
  }

  if (sections.pinned.length > 0) {
    lines.push('### Pinned');
    for (const item of sections.pinned) lines.push(formatLine(item, now));
    lines.push('');
  }

  if (sections.main.length > 0) {
    if (sectioned) lines.push('### Working set');
    for (const item of sections.main) lines.push(formatLine(item, now));
    lines.push('');
  }

  return lines.join('\n');
}

function renderJson(sections: Sections): string {
  const flat = [
    ...sections.attention.map((entry) => ({ item: entry.item, attention: entry.note })),
    ...sections.pinned.map((item) => ({ item, attention: undefined })),
    ...sections.main.map((item) => ({ item, attention: undefined })),
  ];
  return JSON.stringify(
    flat.map(({ item, attention }) => ({
      id: item.id,
      type: item.type,
      title: item.title,
      verified_with: item.verified_with ?? 'assertion',
      created: item.created,
      tags: item.tags,
      source: item.source,
      pinned: item.pinned ?? false,
      stale: item.stale ?? false,
      ...(attention ? { attention } : {}),
      body: truncateBody(item.body),
    })),
    null,
    2,
  );
}

/**
 * Greedy fill in section order — needs-attention, then pinned, then working
 * set — all spending from the same token budget. The capped lists get first
 * claim on the budget (they're the most valuable lines in it); the working
 * set takes whatever remains. The hard item limit spans all three sections.
 */
function budgetSections(
  input: Sections,
  header: string,
  budgetTokens: number,
  totalLimit: number,
  now: number,
): Sections {
  let used = estimateTokens(`${header}\n\n`);
  let total = 0;

  function take<T>(items: T[], cap: number, render: (item: T) => string): T[] {
    const selected: T[] = [];
    for (const item of items) {
      if (selected.length >= cap || total >= totalLimit) break;
      const cost = estimateTokens(`${render(item)}\n`);
      if (used + cost > budgetTokens && total > 0) break;
      selected.push(item);
      used += cost;
      total++;
    }
    return selected;
  }

  const attention = take(input.attention, ATTENTION_CAP, formatAttentionLine);
  const pinned = take(input.pinned, PINNED_CAP, (item) => formatLine(item, now));
  const main = take(input.main, totalLimit, (item) => formatLine(item, now));
  return { attention, pinned, main };
}

export function runContext(options: ContextOptions): string {
  // v0.6.1 (#2): wrap in CompositeStore so configured `stores:` layers surface
  // in retrieval. Without layering this is a single-layer composite — byte-
  // identical to v0.6 behaviour.
  const store = CompositeStore.forCwd(options.cwd);
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
  const config = loadConfig(store.root);

  let header: string;
  let sections: Sections;
  if (options.query) {
    // Query path: a flat relevance-ranked list. Pinned and needs-attention
    // are boot concerns; a targeted retrieval shouldn't repeat them.
    const profile = config.profiles.default;
    const results = store.search(options.query, {
      limit,
      types: explicitType ? [explicitType] : undefined,
      minConfidence: 0,
      ranking: profile?.ranking,
    });
    header = '## Active project memory';
    sections = budgetSections({ attention: [], pinned: [], main: results }, header, budget, limit, now);
  } else {
    const active = store.loadActive();
    const filtered = explicitType ? active.filter((item) => item.type === explicitType) : active;

    const attention = findNeedsAttention(
      filtered,
      projectRootForStore(store.root),
      config.anchors?.repo_search_paths ?? [],
      now,
    );
    // Only the displayed (capped) attention entries leave the working set —
    // overflow beyond the cap still renders there, carrying its ⚠ marker.
    const shownAttention = attention.slice(0, ATTENTION_CAP);
    const attentionIds = new Set(shownAttention.map((entry) => entry.item.id));
    const rest = filtered.filter((item) => !attentionIds.has(item.id));
    const { pinned, main } = partitionPinned(rest);

    const attentionNote = attention.length > 0 ? `, ${attention.length} need attention` : '';
    header = `## Project memory — ${filtered.length} active claims${attentionNote} (memspec_status for detail)`;
    sections = budgetSections(
      { attention: shownAttention, pinned, main: rankActive(main, now, retrievalCounts) },
      header,
      budget,
      limit,
      now,
    );
  }

  const format = options.format ?? 'markdown';
  if (format === 'json') return renderJson(sections);
  if (format !== 'markdown') throw new Error(`Unsupported format: ${format}`);
  return renderMarkdown(sections, header, now);
}
