import { COVERAGE_STOPWORDS } from './stopwords.js';

/**
 * Write-path claim similarity: the one lexical measure `remember` uses both to
 * refuse near-duplicates of an active record and to refuse re-writing a value
 * that was superseded or retracted (the tombstone check). Deterministic,
 * explainable, no model and no index.
 *
 * Shape: weighted Jaccard over the SET of content tokens in title + body.
 *   - Tokens are split on anything that is not a letter or digit, lowercased,
 *     stopword-filtered (the shared coverage list), and lightly stemmed
 *     (plural/-ed/-ied/-ing/trailing-e stripped, then cut to 6 characters) so
 *     "authenticates upstreams" and "upstream authentication" meet.
 *   - Unigrams, not word bigrams: a paraphrase reorders words, and bigram
 *     shingles score a reordered restatement near zero.
 *   - Identifier tokens weigh IDENTIFIER_WEIGHT: anything carrying a digit (a
 *     port, a TTL, a version, a price) and a single capital letter ("Option
 *     B", "node A"), which is kept even though "a" is a stopword. A claim
 *     whose only change is its value ("timeout is 30s" vs "timeout is 60s")
 *     is exactly the pair the tombstone check must keep apart, and at weight
 *     1 a single changed value in a short claim barely moves the score.
 *
 * The threshold was picked from the paired fixtures in
 * test/similarity.test.ts: paraphrases of one claim score >= 0.72, same-topic
 * different claims <= 0.36, and a value change in a short claim 0.60.
 * Known limit, lexical by construction: two short claims that differ only by
 * one swapped qualifier ("staging runs Postgres 16" vs "production runs
 * Postgres 16") score 0.67-0.71 and read as near-duplicates. `remember`'s
 * refusal therefore names the escape: declare the pair `distinct_from`, which
 * records the judgement and exempts that target.
 */

/** Weight of an identifier token (see `isIdentifier`); every other token weighs 1. */
const IDENTIFIER_WEIGHT = 2;

/** Single-capital labels are stored with this prefix so they never meet a lowercased word. */
const LABEL_PREFIX = '#';

/** Stems are cut to this many characters (cheap prefix stemming). */
const STEM_LENGTH = 6;

/**
 * Score at or above which two claims are "the same claim" for `remember`'s
 * near-duplicate refusal and its tombstone check. Between the value-change
 * fixture (0.60) and the weakest fixture paraphrase (0.72). On a real
 * store of ~2.4k active records, 5 same-type pairs score at or above it (all
 * genuine twins on inspection); the next pair down scores 0.59.
 */
export const CLAIM_SIMILARITY_THRESHOLD = 0.65;

/**
 * Below this many weighted content tokens on either side the measure carries
 * no signal (a three-word claim that swaps one word still shares two thirds
 * of itself), so the pair never counts as a near-match. Exact-title refusal
 * still covers identical short titles.
 */
const MIN_SIGNAL_WEIGHT = 6;

const HAS_DIGIT = /\d/;
const WORD = /[\p{L}\p{N}]+/gu;

/** Strip `suffix` when at least three characters remain. */
function stripSuffix(t: string, suffix: string, replacement = ''): string | null {
  return t.endsWith(suffix) && t.length - suffix.length >= 3 ? t.slice(0, t.length - suffix.length) + replacement : null;
}

function stem(token: string): string {
  if (HAS_DIGIT.test(token)) return token;
  let t = stripSuffix(token, 'ies', 'y') ?? stripSuffix(token, 'ied', 'y') ?? stripSuffix(token, 'ing')
    ?? stripSuffix(token, 'ed') ?? stripSuffix(token, 'es')
    ?? (token.endsWith('ss') ? token : stripSuffix(token, 's') ?? token);
  t = stripSuffix(t, 'e') ?? t;
  return t.slice(0, STEM_LENGTH);
}

/** Stemmed content-token set of a claim's title and body. */
export function claimTokens(title: string, body = ''): Set<string> {
  const out = new Set<string>();
  for (const [word] of `${title}\n${body}`.matchAll(WORD)) {
    const raw = word.toLowerCase();
    if (word.length === 1 && raw !== word) {
      out.add(LABEL_PREFIX + raw);
      continue;
    }
    if (COVERAGE_STOPWORDS.has(raw)) continue;
    if (raw.length < 2 && !HAS_DIGIT.test(raw)) continue;
    out.add(stem(raw));
  }
  return out;
}

/** An identifier token (a value: carries a digit, or a single-capital label); see the module note. */
export function isIdentifierToken(token: string): boolean {
  return token.startsWith(LABEL_PREFIX) || HAS_DIGIT.test(token);
}

/** A token as a reader would recognise it (labels lose their internal prefix). */
export function displayToken(token: string): string {
  return token.startsWith(LABEL_PREFIX) ? token.slice(LABEL_PREFIX.length).toUpperCase() : token;
}

function weight(token: string): number {
  return isIdentifierToken(token) ? IDENTIFIER_WEIGHT : 1;
}

/** Total weight of a token collection (the Jaccard denominator's input). */
export function tokenWeight(tokens: Iterable<string>): number {
  let w = 0;
  for (const t of tokens) w += weight(t);
  return w;
}

/**
 * Weighted Jaccard of a token set against a token list with precomputed
 * weights, in [0, 1]; 0 when either side is too thin to judge. The list form
 * lets a caller keep many records' tokens as plain arrays (see claim-index.ts).
 * Skips the walk when the size ratio alone keeps the pair below `floor`
 * (Jaccard never exceeds min(wa, wb) / max(wa, wb)).
 */
export function weightedSimilarity(
  a: ReadonlySet<string>,
  wa: number,
  b: readonly string[],
  wb: number,
  floor = 0,
): number {
  if (wa < MIN_SIGNAL_WEIGHT || wb < MIN_SIGNAL_WEIGHT) return 0;
  if (Math.min(wa, wb) / Math.max(wa, wb) < floor) return 0;
  let shared = 0;
  for (const t of b) if (a.has(t)) shared += weight(t);
  return shared / (wa + wb - shared);
}

/** Weighted Jaccard of two token sets, in [0, 1]; 0 when either side is too thin to judge. */
export function tokenSetSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  return weightedSimilarity(a, tokenWeight(a), [...b], tokenWeight(b));
}

/** Similarity of two claims (title + body). */
export function claimSimilarity(
  a: { title: string; body?: string },
  b: { title: string; body?: string },
): number {
  return tokenSetSimilarity(claimTokens(a.title, a.body), claimTokens(b.title, b.body));
}
