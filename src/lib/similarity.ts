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
 * Postgres 16") score 0.67-0.71 here. `sameClaim`'s wording check (below)
 * separates the shortest of them; in a longer claim one swapped word still
 * reads as a near-duplicate, so `remember`'s refusal names the escape:
 * declare the pair `distinct_from`, which records the judgement and exempts
 * that target.
 *
 * The score alone is not the near-duplicate verdict: a templated claim about
 * a different identifier scores high on shared wording, so `remember` also
 * requires the same identifiers and the same wording about them
 * (`claimShape` / `sameClaim`, below).
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

/*
 * Claim shape: WHAT a claim is about (its identifiers) and WHAT it says about
 * them (its wording). The weighted Jaccard above mixes the two, so a template
 * reads as the claim: "`A` in src/a.ts is set to 2" and "`B` in src/a.ts is
 * set to 3" score 0.68, and a signature fact and an export fact about one
 * symbol in one file score 0.72. `sameClaim` separates them: two claims are
 * the same claim only when neither title names an identifier the other claim
 * does not mention AND they say the same thing (`wording`) about them.
 *
 * An identifier is (raw text, before tokenizing):
 *   - a backticked span or a quoted literal ('...', "...", curly quotes);
 *     a multi-word span also names each identifier inside it (`Postgres
 *     16.2` names 16.2), and a code-marked single capital is a label (`B`);
 *   - a code symbol: camelCase / PascalCase (a lower-or-digit to upper
 *     transition: useState, HttpClient, mTLS), snake_case / UPPER_CASE (an
 *     underscore), a dotted or path-like token (session.ttl, src/a/b.ts);
 *   - anything carrying a digit: a number, a version (v1.2.3, ^4.17.21), a
 *     port, a duration (30s, 30-minute);
 *   - a single-capital label ("Option B"), as in `isIdentifierToken`, except
 *     a sentence-initial "A" and the pronoun "I".
 * Not identifiers: prose slash pairs ("and/or") and provenance pointers (an
 * ISO date, timestamp (Z or numeric offset) or date range, a hex hash of 7+
 * characters, a memspec id or ULID):
 * a later session restating a fact carries a new date or commit, which does
 * not make it a different claim.
 *
 * Identifiers keep their case (code is case-sensitive: `jsx` and `JSX` are
 * two exports; numbers are lowercased). Two kinds, by how a mention in the
 * other claim is recognised:
 *   - strict (code symbols, labels, versions, paths): the same identifier; a
 *     file path also matches the same file named by a shorter or longer path
 *     (hooks/index.ts vs src/jsx/hooks/index.ts), and a directory path a file
 *     inside it;
 *   - loose (`LOOSE_PREFIX`: a plain word or phrase in backticks or quotes,
 *     a number with no `_ . /`): also matched when each of its words
 *     stands alone, same case (numbers in any case: S3 / `s3`), in the
 *     other claim (`main` vs main), or, in a phrase, names an identifier the
 *     other claim mentions. A word inside a path or a symbol does not count:
 *     `css` is not mentioned by 'hono/css', `SELECTORS` not by
 *     PSEUDO_GLOBAL_SELECTOR.
 *
 * Wording: the similarity tokens of what is left once identifiers, labels and
 * provenance pointers are taken out ("is set to", "takes parameters",
 * "exports ... as a runtime value"). Plain words either claim puts in
 * backticks or quotes are left out of both sides' wording when comparing.
 */

/** Prefix of a loose identifier (see above); never produced by the tokenizer. */
const LOOSE_PREFIX = '~';

/**
 * Below this many wording tokens on either side, a claim says nothing beyond
 * its identifiers ("`X` = 2"): the identifiers alone decide.
 */
const MIN_WORDING_WEIGHT = 3;

/**
 * Wording agreement for claims that name the same identifiers. Lower than
 * CLAIM_SIMILARITY_THRESHOLD: the shared identifiers already carry the claim,
 * so a reworded restatement that swaps its verbs ("takes/produces" for
 * "accepts/returns") measured 0.50-0.64 and should read as the same claim,
 * while distinct facts about the same identifiers measured 0.20-0.43. Chosen
 * against the wrongness bench (2,123 templated Hono facts): 0.50 caught every
 * reworded pair but refused 49 distinct facts (a symbol's signature next to
 * its export); 0.55 refuses 3 beyond the two exact-title collisions and lets
 * the two 0.50 rewordings through (SPEC residual).
 */
const WORDING_AGREEMENT_THRESHOLD = 0.55;

const FILE_EXT = /\.(?:[cm]?[jt]sx?|json5?|ya?ml|toml|md|mdx|py|go|rs|java|kt|rb|php|cs|swift|sh|sql|css|scss|html?|txt|lock|cfg|ini|conf|xml|csv|env)$/;
const CODE_SYMBOL = /[\p{Ll}\p{N}]\p{Lu}|_|[\p{L}\p{N}][./][\p{L}\p{N}]/u;
/*
 * Every regex below runs on caller text (MCP bodies) under the store lock and
 * on every claim-index rebuild, so none may backtrack superlinearly: anchored
 * or single-character classes only, and the trailing trims are loops (an
 * end-anchored `[...]+$` retries from every position of a punctuation run,
 * O(n^2) on a whitespace-free run that ends in a letter).
 */
const LEAD_PUNCT = /^[([{<"'`“‘^~=>!*]+/u;
const TRAIL_PUNCT = new Set([...')]}>"\'`”’.,;:!?*…']);
const SENTENCE_CLOSERS = new Set([...'"\')]']);
const SENTENCE_ENDS = new Set([...'.!?:']);
const BACKTICK_SPAN = /`([^`\n]+)`/g;
const QUOTED_SPAN = /(?<![\p{L}\p{N}])(?:"([^"\n]{1,120})"|'([^'\n]{1,120})'|“([^”\n]{1,120})”|‘([^’\n]{1,120})’)(?![\p{L}\p{N}])/gu;
const STANDALONE = /^[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*$/u;
const NO_SIGNAL_DOTTED = new Set(['e.g', 'i.e', 'etc', 'vs']);
const PROSE_SLASH = /^\p{L}+\/\p{L}+$/u;
const SINGLE_CAPITAL = /^\p{Lu}$/u;
/**
 * ISO date (timestamp in Z or with a numeric offset, or range: 2026-09-21/22),
 * hex hash of 7+ characters, memspec id or bare ULID: where a claim came from,
 * not what it is about.
 */
const PROVENANCE = /^(?:\d{4}-\d{2}-\d{2}(?:t[\d:.]+(?:z|[+-]\d{2}(?::?\d{2})?)?)?(?:(?:\/|\.\.|–)\d{1,4}(?:-\d{2}){0,2})?|(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,64}|ms_[0-9a-z]{20,}|(?=[0-9a-z]*\d)[0-9a-hjkmnp-tv-z]{26})$/;

/** `s` without trailing characters of `set` (a loop: linear on any input). */
function trimEnd(s: string, set: ReadonlySet<string>): string {
  let end = s.length;
  while (end > 0 && set.has(s[end - 1])) end--;
  return end === s.length ? s : s.slice(0, end);
}

const strip = (chunk: string): string => trimEnd(chunk.replace(LEAD_PUNCT, ''), TRAIL_PUNCT);
const alnumRuns = (s: string): string[] => s.match(WORD) ?? [];
/** Whether a chunk ends a sentence ("set.", "value:", 'it."'). */
const endsSentence = (chunk: string): boolean => {
  const t = trimEnd(chunk, SENTENCE_CLOSERS);
  return t.length > 0 && SENTENCE_ENDS.has(t[t.length - 1]);
};
/**
 * Key of a standalone word for loose mentions: numbers are lowercased with a
 * leading "v" dropped, as `chunkIdentifier` stores them (S3 / `s3`, v2 / 2).
 */
const wordKey = (w: string): string => (HAS_DIGIT.test(w) ? w.toLowerCase().replace(/^v(?=\d)/, '') : w);

/**
 * Classify one whitespace-free chunk: an identifier, provenance (not one, not
 * wording), or null (wording). Code is case-sensitive (`jsx` and `JSX` are
 * two exports), so identifiers keep their case; only numbers are lowercased.
 */
function chunkIdentifier(chunk: string, markup: boolean): string | 'provenance' | null {
  const c = strip(chunk);
  if (!c || !/[\p{L}\p{N}]/u.test(c)) return null;
  // A code-marked single capital is the label it names in prose (`B` is Option B).
  if (markup && SINGLE_CAPITAL.test(c)) return LABEL_PREFIX + c.toLowerCase();
  const lower = c.toLowerCase();
  if (PROVENANCE.test(lower)) return 'provenance';
  if (NO_SIGNAL_DOTTED.has(lower)) return null;
  if (HAS_DIGIT.test(c)) {
    const value = lower.replace(/^v(?=\d)/, '');
    return /[_./]/.test(value) ? value : LOOSE_PREFIX + value;
  }
  // Prose slash pairs ("and/or", "read/write", "TCP/UDP") are wording, not paths.
  if (CODE_SYMBOL.test(c) && (markup || !PROSE_SLASH.test(c))) return c;
  return markup ? LOOSE_PREFIX + c : null;
}

/** What `sameClaim` and the tombstone read from a claim; see the section note. */
export interface ClaimShape {
  /** Identifiers in title + body. */
  ids: Set<string>;
  /** Identifiers in the title alone (what the claim names; the body is detail). */
  titleIds: Set<string>;
  /** Lowercased words that stand alone in the text (not inside a path or symbol), for loose mentions. */
  words: Set<string>;
  /** Similarity tokens of the text with identifiers, labels and provenance pointers taken out. */
  wording: Set<string>;
}

function scanText(text: string, ids: Set<string>, words: Set<string>, residual: string[]): void {
  const add = (id: string | null) => {
    if (id && id !== 'provenance') ids.add(id);
  };
  // Markup spans are identifiers whole; their words are not wording.
  const spans = [
    ...[...text.matchAll(BACKTICK_SPAN)].map((m) => m[1]),
    ...[...text.matchAll(QUOTED_SPAN)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4]),
  ];
  for (const raw of spans) {
    const span = raw.trim();
    if (!span) continue;
    if (/\s/.test(span)) {
      // A phrase is an identifier whole, and so is each identifier inside it
      // (`Postgres 16.2` names 16.2, `STASH_CALLBACK = 2` names STASH_CALLBACK).
      const parts = span.split(/\s+/);
      add(LOOSE_PREFIX + parts.join(' '));
      parts.forEach((part, i) => add(partIdentifier(part, i === 0)));
    } else add(chunkIdentifier(span, true));
  }
  const prose = text.replace(BACKTICK_SPAN, ' ').replace(QUOTED_SPAN, ' ');
  for (const chunk of text.split(/\s+/)) {
    const bare = strip(chunk);
    if (STANDALONE.test(bare)) for (const w of alnumRuns(bare)) words.add(wordKey(w));
  }
  let sentenceStart = true;
  for (const chunk of prose.split(/\s+/)) {
    if (!chunk) continue;
    const bare = strip(chunk);
    if (SINGLE_CAPITAL.test(bare)) {
      add(partIdentifier(bare, sentenceStart));
    } else {
      const id = chunkIdentifier(chunk, false);
      add(id);
      if (id === null) residual.push(bare);
    }
    sentenceStart = endsSentence(chunk);
  }
}

/**
 * The identifier one word of prose (or of a code phrase) names: a single
 * capital is a label, except the pronoun "I" and an "A" that starts a
 * sentence (or a phrase); anything else as `chunkIdentifier` reads prose.
 */
function partIdentifier(part: string, first: boolean): string | 'provenance' | null {
  const bare = strip(part);
  if (SINGLE_CAPITAL.test(bare)) return bare === 'I' || (bare === 'A' && first) ? null : LABEL_PREFIX + bare.toLowerCase();
  return chunkIdentifier(part, false);
}

/** The shape of a claim (title + body); see the section note. */
export function claimShape(title: string, body = ''): ClaimShape {
  const titleIds = new Set<string>();
  const words = new Set<string>();
  const residual: string[] = [];
  scanText(title, titleIds, words, residual);
  const ids = new Set(titleIds);
  if (body) scanText(body, ids, words, residual);
  const wording = new Set([...claimTokens(residual.join(' '))].filter((t) => !t.startsWith(LABEL_PREFIX)));
  return { ids, titleIds, words, wording };
}

/** Identifiers a claim names (title + body). */
export function claimIdentifiers(title: string, body = ''): Set<string> {
  return claimShape(title, body).ids;
}

/** Path segments and extension of a file-like identifier (one with a `/` or a known file extension), else null. */
function fileRef(id: string): { segments: string[]; ext: string | null } | null {
  if (id.startsWith(LOOSE_PREFIX) || id.startsWith(LABEL_PREFIX)) return null;
  const ext = FILE_EXT.exec(id)?.[0] ?? null;
  if (!ext && !id.includes('/')) return null;
  const stem = ext ? id.slice(0, -ext.length) : id;
  const segments = stem.split('/').filter((s) => s && s !== '.');
  return segments.length > 0 ? { segments, ext } : null;
}

/** The same file named by paths of different length: one segment list ends the other, extensions agree when both carry one. */
function sameFile(a: { segments: string[]; ext: string | null }, b: { segments: string[]; ext: string | null }): boolean {
  if (a.ext && b.ext && a.ext !== b.ext) return false;
  const [short, long] = a.segments.length <= b.segments.length ? [a.segments, b.segments] : [b.segments, a.segments];
  const offset = long.length - short.length;
  return short.every((s, i) => s === long[offset + i]);
}

/**
 * A directory path (no extension, 2+ segments) that contains a FILE the other
 * claim names: the folder of a mentioned file. Not a path without an
 * extension: 'hono/jsx' and 'hono/jsx/dom' are two module specifiers.
 */
function containsPath(dir: { segments: string[]; ext: string | null }, f: { segments: string[]; ext: string | null }): boolean {
  if (dir.ext || !f.ext || dir.segments.length < 2 || dir.segments.length >= f.segments.length) return false;
  for (let start = 0; start + dir.segments.length <= f.segments.length; start++) {
    if (dir.segments.every((s, i) => s === f.segments[start + i])) return true;
  }
  return false;
}

/** What `newIdentifiers` reads from the other claim (a `ClaimShape`, or a claim-index entry). */
export interface IdentifierContext {
  /** Identifiers of the claim; absent when unknown (no exemption is then granted). */
  ids?: readonly string[] | ReadonlySet<string>;
  /** Standalone words of the claim (`ClaimShape.words`). */
  words?: readonly string[] | ReadonlySet<string>;
}

const asSet = (v: readonly string[] | ReadonlySet<string> | undefined): ReadonlySet<string> =>
  v instanceof Set ? v : new Set(v ?? []);

type FileRef = { segments: string[]; ext: string | null };

/** The other claim as `mentionsIdentifier` reads it, built once per comparison. */
interface MentionContext {
  ids: ReadonlySet<string>;
  words: ReadonlySet<string>;
  /** File-like identifiers of `ids`, parsed on first use. */
  files?: FileRef[];
}

function mentionContext(other: IdentifierContext): MentionContext {
  return { ids: asSet(other.ids), words: asSet(other.words) };
}

/** Whether every alphanumeric run of `s` stands alone in the other claim. */
function wordsMentioned(s: string, other: MentionContext): boolean {
  const runs = alnumRuns(s);
  return runs.length > 0 && runs.every((w) => other.words.has(wordKey(w)));
}

/** Whether `other` mentions identifier `id` (see the section note for strict vs loose). */
function mentionsIdentifier(id: string, other: MentionContext): boolean {
  if (other.ids.has(id)) return true;
  if (id.startsWith(LOOSE_PREFIX)) {
    const phrase = id.slice(LOOSE_PREFIX.length);
    if (!phrase.includes(' ')) return wordsMentioned(phrase, other);
    // A phrase: each of its words stands alone in the other claim, or names
    // an identifier the other claim mentions (`Postgres 16.2` vs Postgres 16.2).
    return phrase.split(' ').every((part, i) => {
      if (alnumRuns(part).length === 0 || wordsMentioned(part, other)) return true;
      const inner = partIdentifier(part, i === 0);
      return inner !== null && inner !== 'provenance' && !inner.startsWith(LOOSE_PREFIX) && mentionsIdentifier(inner, other);
    });
  }
  const file = fileRef(id);
  if (!file) return false;
  other.files ??= [...other.ids].map(fileRef).filter((f): f is FileRef => f !== null);
  return other.files.some((f) => sameFile(file, f) || containsPath(file, f));
}

/**
 * Identifiers of `ids` that `other` does not mention, in display form. Empty
 * when `other.ids` is unknown (an entry from before identifiers were indexed):
 * no exemption is granted on missing data.
 */
export function newIdentifiers(ids: Iterable<string>, other: IdentifierContext): string[] {
  if (other.ids === undefined) return [];
  const ctx = mentionContext(other);
  const out: string[] = [];
  for (const id of ids) if (!mentionsIdentifier(id, ctx)) out.push(displayIdentifier(id));
  return out;
}

/** An identifier as a reader would recognise it. */
export function displayIdentifier(id: string): string {
  return id.startsWith(LOOSE_PREFIX) ? id.slice(LOOSE_PREFIX.length) : displayToken(id);
}

/**
 * Whether two claims say the same thing about their identifiers: wording
 * Jaccard at or above WORDING_AGREEMENT_THRESHOLD, or either side too thin
 * (< MIN_WORDING_WEIGHT tokens) to say anything beyond its identifiers.
 */
export function wordingAgrees(
  a: ReadonlySet<string> | readonly string[],
  b: ReadonlySet<string> | readonly string[],
  ignore: ReadonlySet<string> = new Set(),
): boolean {
  const sa = [...asSet(a)].filter((t) => !ignore.has(t));
  const sb = new Set([...asSet(b)].filter((t) => !ignore.has(t)));
  if (sa.length < MIN_WORDING_WEIGHT || sb.size < MIN_WORDING_WEIGHT) return true;
  let shared = 0;
  for (const t of sa) if (sb.has(t)) shared++;
  return shared / (sa.length + sb.size - shared) >= WORDING_AGREEMENT_THRESHOLD;
}

/**
 * Wording tokens of the plain words a claim puts in backticks or quotes
 * (`main`, `release branch`). Its own wording leaves them out (they are
 * identifiers there); the other claim's wording, where the same words may be
 * plain prose, must leave them out too, or the markup alone reads as a
 * difference in what the claims say.
 */
function markupWording(ids: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const id of ids) {
    if (!id.startsWith(LOOSE_PREFIX)) continue;
    for (const t of claimTokens(id.slice(LOOSE_PREFIX.length))) if (!isIdentifierToken(t)) out.add(t);
  }
  return out;
}

/** A claim's shape as `sameClaim` reads it: a `ClaimShape`, or a claim-index entry (fields absent before shapes were indexed). */
export interface ShapeContext extends IdentifierContext {
  titleIds?: readonly string[] | ReadonlySet<string>;
  wording?: readonly string[] | ReadonlySet<string>;
}

/**
 * The near-duplicate verdict for a pair already at or above the similarity
 * threshold: each title names no identifier the other claim does not mention
 * (in its title or body), and the wording agrees. Titles name the claim, the
 * body is detail: a restatement that only adds body detail (more symbols, a
 * date, a commit) is the same claim, and so is a paraphrase whose title moves
 * an identifier into its body. A record whose shape is unknown is judged by
 * similarity alone.
 */
export function sameClaim(incoming: ClaimShape, record: ShapeContext): boolean {
  if (record.ids === undefined || record.titleIds === undefined || record.wording === undefined) return true;
  if (newIdentifiers(incoming.titleIds, record).length > 0 || newIdentifiers(record.titleIds, incoming).length > 0) return false;
  const ignore = markupWording(incoming.ids);
  for (const t of markupWording(record.ids)) ignore.add(t);
  return wordingAgrees(incoming.wording, record.wording, ignore);
}
