import { MemspecStore } from '../lib/store.js';

export interface SearchOptions {
  cwd?: string;
  type?: string;
  limit?: string;
  json?: boolean;
}

export function runSearch(query: string, options: SearchOptions): string {
  const store = new MemspecStore(options.cwd);
  const limit = parseInt(options.limit ?? '10', 10);
  if (Number.isNaN(limit) || limit < 1) {
    throw new Error(`Invalid limit: ${options.limit}`);
  }

  if (options.type && !['fact', 'decision', 'procedure'].includes(options.type)) {
    throw new Error(`Unsupported memory type: ${options.type}`);
  }

  const results = store.search(query, limit, options.type as 'fact' | 'decision' | 'procedure' | undefined);

  if (results.length === 0) {
    return `No results for "${query}"`;
  }

  if (options.json) {
    return JSON.stringify(results.map((r) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      confidence: r.confidence,
      created: r.created,
      tags: r.tags,
      source: r.source,
    })), null, 2);
  }

  const lines: string[] = [`${results.length} result(s) for "${query}"`, ''];

  for (const item of results) {
    lines.push(`[${item.type}] ${item.title} (${item.confidence.toFixed(2)})`);
    lines.push(`  ${item.id} | ${item.created.substring(0, 10)} | ${item.source}`);
    if (item.tags.length > 0) {
      lines.push(`  tags: ${item.tags.join(', ')}`);
    }
    const bodyLines = item.body.split('\n').filter((l) => !l.startsWith('#'));
    const preview = bodyLines.slice(0, 2).join(' ').trim().substring(0, 120);
    if (preview) lines.push(`  ${preview}`);
    lines.push('');
  }

  return lines.join('\n');
}
