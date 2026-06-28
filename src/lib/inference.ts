import type { MemoryItem, MemoryType } from './types.js';

/**
 * Tokenise a title for lexical comparison. Matches the rule used by
 * `search.ts:annotateConflicts` (post-`split(/\s+/)`, filter tokens of
 * length > 3) so write-path and query-path inference stay in lockstep.
 *
 * Short tokens (`the`, `is`, `a`, …) are noise and inflate overlap scores
 * without carrying meaning; the > 3 cutoff is the v0.3 rule.
 */
export function tokeniseTitle(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 3),
  );
}

/** Number of overlapping tag strings between two records. */
export function sharedTagCount(aTags: readonly string[], bTags: readonly string[]): number {
  if (aTags.length === 0 || bTags.length === 0) return 0;
  const bSet = new Set(bTags);
  let count = 0;
  for (const t of aTags) if (bSet.has(t)) count++;
  return count;
}

/** Number of overlapping title tokens (length > 3) between two records. */
export function titleTokenOverlap(aTitle: string, bTitle: string): number {
  const a = tokeniseTitle(aTitle);
  if (a.size === 0) return 0;
  const b = tokeniseTitle(bTitle);
  let count = 0;
  for (const t of a) if (b.has(t)) count++;
  return count;
}

/**
 * The v0.3 conflict-inference rule, lifted intact: same type + at least
 * one shared tag + at least two overlapping title tokens. Phase 5 ports
 * this from `search.ts:annotateConflicts` to the write path so the same
 * predicate is the basis for mid-band auto-attach in `remember`.
 *
 * Lexical only — no embeddings, no learned thresholds. Cheap to compute
 * and explainable.
 */
export function matchesConflictInferenceRule(
  aType: MemoryType,
  aTitle: string,
  aTags: readonly string[],
  bType: MemoryType,
  bTitle: string,
  bTags: readonly string[],
): boolean {
  if (aType !== bType) return false;
  if (sharedTagCount(aTags, bTags) === 0) return false;
  if (titleTokenOverlap(aTitle, bTitle) < 2) return false;
  return true;
}

export interface NeighbourScore {
  item: MemoryItem;
  tokenOverlap: number;
  tagOverlap: number;
}

/**
 * Rank candidate neighbours by (tokenOverlap desc, tagOverlap desc).
 * Same-type filter is the caller's job — this helper just scores.
 * Stable for ties so callers can rely on insertion order at equal score.
 */
export function rankByLexicalCloseness(
  title: string,
  tags: readonly string[],
  candidates: readonly MemoryItem[],
): NeighbourScore[] {
  return candidates
    .map<NeighbourScore>((item) => ({
      item,
      tokenOverlap: titleTokenOverlap(title, item.title),
      tagOverlap: sharedTagCount(tags, item.tags),
    }))
    .sort((a, b) => {
      if (b.tokenOverlap !== a.tokenOverlap) return b.tokenOverlap - a.tokenOverlap;
      return b.tagOverlap - a.tagOverlap;
    });
}

/** Case-insensitive normalisation for exact-title duplicate refusal. */
export function normaliseTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}
