import { ulid } from 'ulid';
import { MemspecStore } from '../lib/store.js';
import { DEFAULT_DECAY_DAYS, MEMORY_TYPES, type MemoryType } from '../lib/types.js';

export interface AddOptions {
  cwd?: string;
  body?: string;
  source?: string;
  tags?: string;
  decayAfter?: string;
}

function assertMemoryType(input: string): MemoryType {
  if ((MEMORY_TYPES as readonly string[]).includes(input)) {
    return input as MemoryType;
  }
  throw new Error(`Unsupported memory type: ${input}`);
}

function toDecayAfter(type: MemoryType, override?: string, now: Date = new Date()): string {
  if (override === 'never') return 'never';
  if (override) return override;

  const expires = new Date(now);
  expires.setUTCDate(expires.getUTCDate() + DEFAULT_DECAY_DAYS[type]);
  return expires.toISOString();
}

function parseTags(raw?: string): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

export function runAdd(typeInput: string, title: string, options: AddOptions): string {
  const type = assertMemoryType(typeInput);
  const store = new MemspecStore(options.cwd);
  store.init();

  const created = new Date().toISOString();
  const id = `ms_${ulid()}`;
  const filePath = store.writeItem({
    id,
    type,
    state: 'active',
    confidence: 0.7,
    created,
    source: options.source ?? 'unknown',
    tags: parseTags(options.tags),
    decay_after: toDecayAfter(type, options.decayAfter),
    title,
    body: options.body ?? '',
  });

  return `Created ${type} memory at ${filePath}`;
}
