import { checkAnchors, getCodeAnchors } from './anchors.js';
import type { MemoryItem, MemoryType, VerifiedWith } from './types.js';
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

    if (item.check_by !== 'never') {
      let expiryTime: number;

      if (item.check_by) {
        expiryTime = Date.parse(item.check_by);
      } else {
        const ttlDays = item.type ? (DEFAULT_DECAY_DAYS[item.type] ?? 90) : 90;
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
      // Same comparison as the search read path (the remote default branch),
      // so status's drift count agrees with what search marks [DRIFTED].
      const drifted = checkAnchors(options.projectRoot, anchors, { compareTo: 'default-branch' })
        .filter((a) => a.status !== 'unchanged');
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

/** Read-time aging signal for one record (see `agingOf`). */
export interface AgingSignal {
  aged: true;
  unverified_days: number;
}

/**
 * Aging signal: an active claim witnessed only by `assertion` whose
 * `last_verified` (or `created`, when never verified) is more than
 * `agingDays` old. Returns null when the record does not qualify.
 *
 * Deliberately independent of `check_by`. The review window says when a claim
 * is due a look; this says how long it has stood on nothing but its author's
 * word. A 180-day decision TTL let a team decision from May keep ranking as
 * current in October after the facts it cited had changed — an agent read
 * `stale: false` as "still true" and repeated it.
 *
 * Exclusions, so the flag stays a signal and not noise:
 * - `check_by: "never"` — an explicit pin (operator `verify --check-by never`,
 *   settled event history). Legacy `decay_after: never` no longer reaches here
 *   as `never` (see `legacyNeverCheckBy`).
 * - `stale: true` — the stale flag already says "check before relying".
 * - non-active records, observations, questions — they do not assert current
 *   truth in the first place.
 *
 * `witness` is passed in rather than recomputed so every surface ages on the
 * same witness it displays. `agingDays <= 0` disables the signal.
 */
export function agingOf(item: MemoryItem, witness: VerifiedWith, agingDays: number, now = Date.now()): AgingSignal | null {
  if (agingDays <= 0) return null;
  if (witness !== 'assertion') return null;
  if (item.state !== 'active' || item.kind === 'observation' || item.kind === 'question') return null;
  if (item.check_by === 'never' || item.stale) return null;
  const base = Date.parse(item.last_verified ?? item.created);
  if (Number.isNaN(base)) return null;
  const elapsed = now - base;
  if (elapsed <= agingDays * 24 * 60 * 60 * 1000) return null;
  return { aged: true, unverified_days: Math.floor(elapsed / (24 * 60 * 60 * 1000)) };
}
