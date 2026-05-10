import { loadConfig } from '../lib/config.js';
import { MemspecStore } from '../lib/store.js';
import { MEMORY_TYPES, type MemoryItem, type MemoryType } from '../lib/types.js';

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
const BODY_PREVIEW_CHARS = 200;

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

function rankActive(items: MemoryItem[]): MemoryItem[] {
  // Recency × confidence as the spec calls for. Decreasing recency factor
  // by item age, multiplied by confidence so a high-confidence older item
  // can still beat a low-confidence very recent one.
  const now = Date.now();
  return [...items]
    .map((item) => {
      const ageMs = Math.max(0, now - Date.parse(item.created));
      const ageDays = ageMs / (24 * 60 * 60 * 1000);
      const recency = 1 / (1 + ageDays);
      const score = recency * Math.max(0.01, item.confidence);
      return { item, score };
    })
    .sort((a, b) => b.score - a.score || b.item.confidence - a.item.confidence)
    .map(({ item }) => item);
}

function renderMarkdown(items: MemoryItem[]): string {
  if (items.length === 0) {
    return '## Active project memory\n\n_No active memories._\n';
  }

  const lines: string[] = ['## Active project memory', ''];
  for (const item of items) {
    lines.push(`- **${item.title}** _(${item.type})_`);
    const preview = truncateBody(item.body);
    if (preview) {
      lines.push(`  ${preview}`);
    }
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
      confidence: item.confidence,
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
  let used = estimateTokens('## Active project memory\n\n');
  for (const item of items) {
    if (selected.length >= hardLimit) break;
    const preview = truncateBody(item.body);
    const cost = estimateTokens(`- **${item.title}** _(${item.type})_\n  ${preview}\n`);
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
    candidates = rankActive(filtered).slice(0, limit);
  }

  const selected = selectWithinBudget(candidates, budget, limit);

  const format = options.format ?? 'markdown';
  if (format === 'json') return renderJson(selected);
  if (format !== 'markdown') throw new Error(`Unsupported format: ${format}`);
  return renderMarkdown(selected);
}
