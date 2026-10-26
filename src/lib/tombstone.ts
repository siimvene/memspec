import type { ClaimIndexEntry } from './claim-index.js';
import { CLAIM_SIMILARITY_THRESHOLD, displayToken, isIdentifierToken, weightedSimilarity } from './similarity.js';

/**
 * Rejected values (the tombstone): a value a supersede replaced or retracted
 * must not come back through another write. One rule, applied to every write
 * that carries claim text (`remember`, a `supersede` replacement body):
 *
 *   For every archived claim R that is a rejection (see `scanArchive`),
 *   scanned across ALL types and ALL scopes (an archived rejection is a
 *   rejection everywhere): when sim(claim, R) >= CLAIM_SIMILARITY_THRESHOLD
 *   the write is refused UNLESS
 *     - R has an active survivor S (the record holding R's place now), and
 *     - the claim carries no identifier R had that S lacks (a number or
 *       single-capital label the correction removed: the rejected value
 *       itself, see similarity.ts `isIdentifierToken`), and
 *     - sim(claim, S') > sim(claim, R) + REJECTION_MARGIN, where S' holds
 *       R's place once this write lands (S, or the claim itself when the
 *       write supersedes S): measurably closer to the current value, and
 *     - sim(claim, S) >= sim(claim, R) (implied by the margin when S' = S).
 *   A retraction (no survivor) always refuses. Caller-declared edges
 *   (distinct_from, refines, ...) exempt nothing.
 *
 * Why more than the margin: when the write is itself the supersede of S the
 * claim is its own survivor and scores 1.0 against it, so the margin alone
 * only stops a verbatim restatement; the old value with filler is caught by
 * the last condition (closer to R than to S) and, for a value carried by an
 * identifier, by the removed-identifier condition, which also catches a
 * claim in S's wording carrying R's number. A third value passes both: it
 * carries no removed identifier and sits as close to S as to R. Lexical
 * limit: a value spelled differently ("thirty" for "30") reads as a third
 * value, and a non-identifier value written in S's wording ("Redis" in the
 * Memcached record's sentences) is judged by similarity alone.
 *
 * Over MCP a refusal is final. On the CLI `--allow-rejected` writes anyway
 * and the override is logged into the new record.
 *
 * The margin was picked from the case table in test/tombstone-rule.test.ts
 * (realistic multi-sentence and short claims, number- and word-valued
 * changes). Of the cases that cross the threshold against R, every genuine
 * claim stating the current value sits 0.08-0.17 closer to S (0.08 for a
 * word-valued change, where one token of ~25 differs), and every refused one
 * 0.00 or less (both values named, a third value, the old value with filler
 * at -0.08 to -0.11). 0.05 sits inside that gap with room on both sides.
 */
export const REJECTION_MARGIN = 0.05;

/**
 * Store-wide lock key (lib/lock.ts) every claim write that the tombstone reads
 * or changes holds: `remember` (check + write) and `supersede` (archive +
 * replacement). Kept as `remember` so a lock file left by an older build
 * still serializes.
 */
export const CLAIM_WRITE_LOCK = 'remember';

/** The incoming claim's similarity tokens (see similarity.ts `claimTokens`). */
export interface IncomingClaim {
  tokens: ReadonlySet<string>;
  weight: number;
}

/** An archived record whose rejected value the incoming claim re-asserts. */
export interface RejectedValueMatch {
  id: string;
  title: string;
  reason: string;
  /** Direct `superseded_by`; absent for a retraction. */
  supersededBy?: string;
  /** The live end of the `superseded_by` chain before this write, when one is still active. */
  survivor?: string;
  similarity: number;
  /** Similarity to `survivor` (before this write). */
  survivorSimilarity?: number;
  /** Identifiers the claim carries that R had and its survivor lacks (display form). */
  removedValues: string[];
}

/** A merged-away record the incoming claim restates, and the active survivor that holds it. */
export interface MergedPieceMatch {
  piece: ClaimIndexEntry;
  survivor: ClaimIndexEntry;
  similarity: number;
}

/**
 * The archive changes a `supersede` is about to make, so the rule is judged
 * against the state the write produces: `replaced` ids are archived with
 * `supersede_kind: replace`, `merged` ids with `merge`, both pointing at
 * `newId`, which becomes the active record holding the incoming claim. The
 * records this write archives are not themselves rejections yet: only
 * records archived before it are scanned.
 */
export interface PendingSupersede {
  newId: string;
  replaced: readonly string[];
  merged: readonly string[];
}

/** Follow `superseded_by` from an archived record to the active record that now holds its place, if any. */
export function activeSurvivor(item: ClaimIndexEntry, byId: ReadonlyMap<string, ClaimIndexEntry>): ClaimIndexEntry | undefined {
  const seen = new Set<string>();
  let cur: ClaimIndexEntry | undefined = item;
  while (cur && cur.state !== 'active' && cur.superseded_by && !seen.has(cur.id)) {
    seen.add(cur.id);
    cur = byId.get(cur.superseded_by);
  }
  return cur && cur.state === 'active' ? cur : undefined;
}

/**
 * The active record that still holds `old`'s value through consolidation
 * alone, if any: `superseded_by` is followed only while every hop was stamped
 * `ext.supersede_kind: merge`. One replacement or retraction anywhere on the
 * way means the value was rejected at that hop (a piece merged into S, then S
 * replaced by T, is not held by T). A record archived before the marker
 * existed carries none and counts as rejected: the survivor's `supersedes`
 * length cannot tell a merge from a replacement.
 */
export function mergeHolder(old: ClaimIndexEntry, byId: ReadonlyMap<string, ClaimIndexEntry>): ClaimIndexEntry | undefined {
  const seen = new Set<string>();
  let cur: ClaimIndexEntry = old;
  while (cur.state !== 'active') {
    if (seen.has(cur.id) || cur.supersede_kind !== 'merge' || !cur.superseded_by) return undefined;
    seen.add(cur.id);
    const next = byId.get(cur.superseded_by);
    if (!next) return undefined;
    cur = next;
  }
  return cur;
}

/**
 * Judge an incoming claim against every archived claim in `entries` (one
 * store's claim index, all types, all scopes). Returns the rejections it
 * re-asserts (refuse; see the module rule) and the merged pieces it restates
 * (consolidated, not rejected: the caller refuses those as a near-duplicate
 * of the survivor that holds them). A merged piece whose holder is the
 * record this write creates is not reported (the write holds it).
 */
export function scanArchive(
  entries: readonly ClaimIndexEntry[],
  incoming: IncomingClaim,
  pending?: PendingSupersede,
): { rejected: RejectedValueMatch[]; merged: MergedPieceMatch[] } {
  const before = new Map(entries.map((e) => [e.id, e]));
  const after = new Map(before);
  if (pending) {
    const archive = (id: string, kind: 'replace' | 'merge') => {
      const e = before.get(id);
      if (e) after.set(id, { ...e, state: 'superseded', superseded_by: pending.newId, supersede_kind: kind });
    };
    for (const id of pending.replaced) archive(id, 'replace');
    for (const id of pending.merged) archive(id, 'merge');
    after.set(pending.newId, {
      id: pending.newId,
      kind: 'claim',
      state: 'active',
      title: '(this write)',
      tokens: [...incoming.tokens],
      weight: incoming.weight,
    });
  }
  const similarityTo = (e: ClaimIndexEntry, floor = 0): number =>
    e.id === pending?.newId ? 1 : weightedSimilarity(incoming.tokens, incoming.weight, e.tokens, e.weight, floor);

  const rejected: RejectedValueMatch[] = [];
  const merged: MergedPieceMatch[] = [];
  for (const r of entries) {
    if (r.kind !== 'claim' || r.state !== 'superseded') continue;
    const similarity = similarityTo(r, CLAIM_SIMILARITY_THRESHOLD);
    if (similarity < CLAIM_SIMILARITY_THRESHOLD) continue;

    const holder = mergeHolder(r, after);
    if (holder) {
      if (holder.id !== pending?.newId) merged.push({ piece: r, survivor: holder, similarity });
      continue;
    }

    // `current` is the value the correction installed (before this write);
    // `survivorAfter` is who holds R's place once this write lands (the
    // incoming claim itself when this write supersedes `current`).
    const current = activeSurvivor(r, before);
    const survivorAfter = activeSurvivor(r, after);
    let removedValues: string[] = [];
    let survivorSimilarity: number | undefined;
    if (current) {
      const kept = new Set(current.tokens);
      removedValues = r.tokens.filter((t) => isIdentifierToken(t) && !kept.has(t) && incoming.tokens.has(t)).map(displayToken);
      survivorSimilarity = similarityTo(current);
      // When this write is the supersede of `current`, `survivorAfter` is the
      // claim itself (similarity 1): the margin then only stops a verbatim
      // restatement, so the claim must also be no closer to R than to the
      // value it replaces (the old value with filler is; a third value is not).
      if (
        survivorAfter && removedValues.length === 0 &&
        survivorSimilarity >= similarity &&
        similarityTo(survivorAfter) > similarity + REJECTION_MARGIN
      ) continue;
    }
    rejected.push({
      id: r.id,
      title: r.title,
      reason: r.supersede_reason ?? '(no reason recorded)',
      ...(r.superseded_by ? { supersededBy: r.superseded_by } : {}),
      ...(current ? { survivor: current.id, survivorSimilarity } : {}),
      similarity,
      removedValues,
    });
  }
  rejected.sort((a, b) => b.similarity - a.similarity);
  merged.sort((a, b) => b.similarity - a.similarity);
  return { rejected, merged };
}

export function describeRejection(m: RejectedValueMatch): string {
  const fate = m.supersededBy === undefined
    ? 'retracted with no replacement'
    : m.survivor === undefined
      ? `superseded by ${m.supersededBy} (no longer active)`
      : m.survivor === m.supersededBy
        ? `superseded by ${m.supersededBy}`
        : `superseded by ${m.supersededBy} (now ${m.survivor})`;
  const scores = m.survivorSimilarity === undefined
    ? `similarity ${m.similarity.toFixed(2)}`
    : `similarity ${m.similarity.toFixed(2)} to it, ${m.survivorSimilarity.toFixed(2)} to the current record`;
  const values = m.removedValues.length > 0 ? `; carries ${m.removedValues.join(', ')}, which the correction removed` : '';
  return `this value was rejected in ${m.id} (reason: ${m.reason}), ${fate} [${scores}${values}]`;
}

/** `ext.rejected_value_overrides` entries for a CLI `--allow-rejected` write. */
export function rejectedValueOverrides(matches: RejectedValueMatch[], at: string, by: string): Array<Record<string, unknown>> {
  return matches.map((m) => ({
    id: m.id,
    reason: m.reason,
    ...(m.supersededBy ? { superseded_by: m.supersededBy } : {}),
    similarity: Number(m.similarity.toFixed(2)),
    ...(m.removedValues.length > 0 ? { removed_values: m.removedValues } : {}),
    overridden_at: at,
    overridden_by: by,
  }));
}

/** The refusal for a write that re-asserts a rejected value. */
export function rejectedValueError(verb: 'remember' | 'supersede', matches: RejectedValueMatch[], viaMcp: boolean): Error {
  const detail = matches.map(describeRejection).join('; ');
  const survivors = [...new Set(matches.map((m) => m.survivor).filter((s): s is string => s !== undefined))];
  const changeValue = survivors.length > 0
    ? `To record a different current value, supersede ${survivors.join(' or ')} with it (a body that restates the rejected value is refused there too). `
    : '';
  return new Error(
    `${verb} refuses rejected value: ${detail}. ` +
      (viaMcp
        ? `This refusal is final over MCP. ${changeValue}If new evidence shows the rejection was wrong, a human runs \`memspec ${verb} ... --allow-rejected\` at a terminal.`
        : `${changeValue}If new evidence shows the rejection was wrong, pass --allow-rejected to write it anyway (the override is logged into the new record).`),
  );
}

/** The refusal for a write that restates a record a merge consolidated into a live survivor. */
export function mergedPieceError(verb: 'remember' | 'supersede', matches: MergedPieceMatch[], viaMcp: boolean): Error {
  const survivors = [...new Map(matches.map((m) => [m.survivor.id, m.survivor])).values()];
  const pieceList = matches
    .map((m) => `${m.piece.id} "${m.piece.title}" (similarity ${m.similarity.toFixed(2)}), merged into the active ${m.survivor.type ?? 'claim'} ${m.survivor.id} "${m.survivor.title}"`)
    .join('; ');
  const ids = survivors.map((s) => s.id).join(' ');
  return new Error(
    `${verb} refuses near-duplicate: this claim restates a record consolidated by a merge (${pieceList}). ` +
      `The survivor already holds it: update it with ${survivors.map((s) => `\`memspec supersede ${s.id}\``).join(' or ')} instead of writing the piece back as a twin. ` +
      (viaMcp
        ? `Over MCP this refusal is final (declared edges do not exempt it); if this is a different claim, a human writes it at a terminal with --distinct-from ${ids}.`
        : verb === 'remember'
          ? `If you compared them and this is a different claim, declare it with distinct_from (--distinct-from ${ids}).`
          : 'Pass --allow-rejected to write it anyway (logged into the new record).'),
  );
}
