import { ulid } from 'ulid';
import { getDecayDays, loadConfig } from '../lib/config.js';
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

export function runAdd(typeInput: string, title: string, options: AddOptions): string {
  const type = assertMemoryType(typeInput);
  const store = new MemspecStore(options.cwd);
  store.init();

  const config = loadConfig(store.root);
  const decayDays = getDecayDays(config, type);

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
    source: options.source ?? 'unknown',
    tags: parseTags(options.tags),
    decay_after: toDecayAfter(type, decayDays, options.decayAfter),
    title,
    body: options.body ?? '',
  };

  if (stabilize) {
    itemData.ext = { confirmations: 0, confirmed_by: [] };
  }

  const filePath = store.writeItem(itemData);

  return `Created ${type} memory at ${filePath}`;
}
