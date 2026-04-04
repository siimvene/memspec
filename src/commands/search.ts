import { getProfile, loadConfig } from '../lib/config.js';
import { MemspecStore } from '../lib/store.js';
import { MEMORY_TYPES, type MemoryType } from '../lib/types.js';

export interface SearchOptions {
  cwd?: string;
  type?: string;
  limit?: string;
  json?: boolean;
  profile?: string;
}

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

export function runSearch(query: string, options: SearchOptions): string {
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
  const results = store.search(query, {
    limit,
    types,
    minConfidence: profile.min_confidence ?? 0,
    ranking: profile.ranking,
  });

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
