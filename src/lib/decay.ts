import type { MemoryItem, MemoryType } from './types.js';
import { DEFAULT_DECAY_DAYS } from './types.js';

export interface DecayCandidate {
  item: MemoryItem;
  reason: string;
  daysExpired: number;
}

export function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)([dhm])$/);
  if (!match) return 90 * 24 * 60 * 60 * 1000;

  const value = parseInt(match[1], 10);
  switch (match[2]) {
    case 'd': return value * 24 * 60 * 60 * 1000;
    case 'h': return value * 60 * 60 * 1000;
    case 'm': return value * 60 * 1000;
    default: return value * 24 * 60 * 60 * 1000;
  }
}

export function findDecayCandidates(items: MemoryItem[]): DecayCandidate[] {
  const now = Date.now();
  const candidates: DecayCandidate[] = [];

  for (const item of items) {
    if (item.state !== 'active') continue;
    if (item.decay_after === 'never') continue;

    let expiryTime: number;

    if (item.decay_after) {
      expiryTime = Date.parse(item.decay_after);
    } else {
      const ttlDays = DEFAULT_DECAY_DAYS[item.type] ?? 90;
      expiryTime = Date.parse(item.created) + ttlDays * 24 * 60 * 60 * 1000;
    }

    if (isNaN(expiryTime)) continue;

    if (now > expiryTime) {
      const daysExpired = Math.floor((now - expiryTime) / (24 * 60 * 60 * 1000));
      candidates.push({
        item,
        reason: `TTL expired ${daysExpired} day(s) ago`,
        daysExpired,
      });
    }
  }

  return candidates.sort((a, b) => b.daysExpired - a.daysExpired);
}
