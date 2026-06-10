import { checkAnchors, getCodeAnchors } from './anchors.js';
import type { MemoryItem, MemoryType } from './types.js';
import { DEFAULT_DECAY_DAYS } from './types.js';

export interface DecayCandidate {
  item: MemoryItem;
  reason: string;
  daysExpired: number;
  /**
   * 'expired' — calendar TTL passed; eligible for decay/archive.
   * 'anchor-drift' — an anchored file changed since last verification;
   * surfaced for review (verify/correct/re-anchor), never auto-archived.
   */
  kind: 'expired' | 'anchor-drift';
}

export interface DecayScanOptions {
  /** When set, active memories with ext.code_anchors are checked for drift against files under this root. */
  projectRoot?: string;
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

export function findDecayCandidates(items: MemoryItem[], options: DecayScanOptions = {}): DecayCandidate[] {
  const now = Date.now();
  const candidates: DecayCandidate[] = [];

  for (const item of items) {
    if (item.state !== 'active') continue;

    if (item.decay_after !== 'never') {
      let expiryTime: number;

      if (item.decay_after) {
        expiryTime = Date.parse(item.decay_after);
      } else {
        const ttlDays = DEFAULT_DECAY_DAYS[item.type] ?? 90;
        expiryTime = Date.parse(item.last_verified ?? item.created) + ttlDays * 24 * 60 * 60 * 1000;
      }

      if (!isNaN(expiryTime) && now > expiryTime) {
        const daysExpired = Math.floor((now - expiryTime) / (24 * 60 * 60 * 1000));
        candidates.push({
          item,
          reason: `TTL expired ${daysExpired} day(s) ago`,
          daysExpired,
          kind: 'expired',
        });
        continue; // expired wins; drift on an already-expired item adds nothing
      }
    }

    if (options.projectRoot) {
      const anchors = getCodeAnchors(item);
      if (anchors.length === 0) continue;
      const drifted = checkAnchors(options.projectRoot, anchors).filter((a) => a.status !== 'unchanged');
      if (drifted.length > 0) {
        candidates.push({
          item,
          reason: `anchor drift: ${drifted.map((a) => `${a.file} (${a.status})`).join(', ')}`,
          daysExpired: 0,
          kind: 'anchor-drift',
        });
      }
    }
  }

  return candidates.sort((a, b) => b.daysExpired - a.daysExpired);
}
