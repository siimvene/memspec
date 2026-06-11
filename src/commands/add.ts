import { ulid } from 'ulid';
import { getDecayDays, loadConfig } from '../lib/config.js';
import { inferSourceKind } from '../lib/source.js';
import { MemspecStore } from '../lib/store.js';
import { MEMORY_TYPES, type MemoryType } from '../lib/types.js';

export interface AddOptions {
  cwd?: string;
  body?: string;
  source?: string;
  tags?: string;
  decayAfter?: string;
  store?: string;  // target store layer name (e.g., 'global')
}

export interface DuplicateMatch {
  id: string;
  title: string;
  score: number;
}

export interface AddResult {
  message: string;
  duplicates?: DuplicateMatch[];
}

function assertMemoryType(input: string): MemoryType {
  if ((MEMORY_TYPES as readonly string[]).includes(input)) {
    return input as MemoryType;
  }
  throw new Error(`Unsupported memory type: ${input}`);
}

function toDecayAfter(type: MemoryType, decayDays: number, override?: string, now: Date = new Date()): string {
  if (override === 'never') return 'never';
  if (override) return override;

  const expires = new Date(now);
  expires.setUTCDate(expires.getUTCDate() + decayDays);
  return expires.toISOString();
}

function parseTags(raw?: string): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

export function runAdd(typeInput: string, title: string, options: AddOptions): AddResult {
  const type = assertMemoryType(typeInput);

  const source = options.source?.trim();
  if (!source || source.toLowerCase() === 'unknown') {
    throw new Error(
      'source is required and may not be "unknown" — pass --source <who-is-writing> (e.g. --source human:siim, --source claude-code)',
    );
  }

  const store = new MemspecStore(options.cwd);
  store.init();

  const config = loadConfig(store.root);
  const decayDays = getDecayDays(config, type);

  // Pre-flight dedup check: search existing memories for potential duplicates
  let duplicates: DuplicateMatch[] | undefined;
  try {
    const existing = store.search(title, { types: [type], limit: 3 });
    if (existing.length > 0) {
      duplicates = existing.map((item) => ({
        id: item.id,
        title: item.title,
        // BM25 returns negative scores; invert for a positive relevance score
        score: item.confidence,
      }));
    }
  } catch {
    // Search failure should not block memory creation
  }

  const created = new Date().toISOString();
  const id = `ms_${ulid()}`;

  const stabilize = config.stabilization.enabled;
  const state = stabilize ? 'captured' : 'active';
  const confidence = stabilize ? 0.5 : 0.7;

  const itemData: Parameters<typeof store.writeItem>[0] = {
    id,
    type,
    state,
    confidence,
    created,
    source,
    source_kind: inferSourceKind(source),
    tags: parseTags(options.tags),
    decay_after: toDecayAfter(type, decayDays, options.decayAfter),
    last_verified: created,
    title,
    body: options.body ?? '',
  };

  if (stabilize) {
    itemData.ext = { confirmations: 0, confirmed_by: [] };
  }

  const filePath = store.writeItem(itemData);

  return {
    message: `Created ${type} memory at ${filePath}`,
    duplicates: duplicates && duplicates.length > 0 ? duplicates : undefined,
  };
}
