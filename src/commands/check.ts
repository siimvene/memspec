/**
 * v0.13 — `memspec check`: the merge-time contradiction check.
 *
 * Team stores share `.memspec/` through pull requests. One file per record
 * means git never conflicts, and `remember`'s near-duplicate refusal and
 * `suggested_conflicts` are same-type and only see the writer's local view, so
 * two records that contradict each other merge silently a week apart. This
 * command looks at the records a change set ADDS or EDITS (content, not
 * frontmatter) and fails when one plausibly overlaps another active claim in
 * the same store without a recorded relationship between them.
 *
 * Read-only by construction: it loads one store (`MemspecStore`, never the
 * layered view: the check is about the files in THIS repo), runs git
 * read-only, tokenises through an in-memory FTS5 table, and writes nothing.
 */

import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseMemoryFile } from '../lib/frontmatter.js';
import { tokenizeLikeIndex } from '../lib/fts.js';
import { defaultBranchOf, gitRaw } from '../lib/git-state.js';
import { normaliseTitle } from '../lib/inference.js';
import { COVERAGE_STOPWORDS } from '../lib/stopwords.js';
import { MemspecStore } from '../lib/store.js';
import type { MemoryItem, MemoryType } from '../lib/types.js';

/** A pair with a file signal (shared anchor or path mention) needs this many shared title terms. */
export const FILE_SIGNAL_MIN_SHARED_TERMS = 2;
/** A pair with no file signal needs this many shared title terms ... */
export const TITLE_ONLY_MIN_SHARED_TERMS = 3;
/** ... and at least this overlap (shared / smaller title-term set). */
export const TITLE_ONLY_MIN_OVERLAP = 0.5;
/** Anchored paths shorter than this are too generic to count as a mention in another record's text. */
export const ANCHOR_PATH_MIN_LENGTH = 5;
/** Title words shorter than this are dropped before tokenising. */
export const TITLE_WORD_MIN_LENGTH = 3;
/** The document-frequency filter applies only to stores with at least this many active claims. */
export const DF_FILTER_MIN_CLAIMS = 40;
/** A title term occurring in more than this fraction of active-claim titles is dropped. */
export const DF_FILTER_MAX_FRACTION = 0.05;

/** Edge lists that acknowledge an overlap (either record, either direction). `conflicts_with` does not. */
const ACK_EDGES = ['supersedes', 'refines', 'supports', 'depends_on', 'derived_from', 'distinct_from'] as const;

/** A usage or git error: the CLI exits 2 so CI never reads an error as a pass. */
export class CheckUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckUsageError';
  }
}

export interface CheckOptions {
  /** Working directory the store resolves from when `store` is absent. */
  cwd?: string;
  /** A `.memspec` directory or its parent. */
  store?: string;
  /** Git ref to compare against; defaults to the repo's remote default branch. */
  base?: string;
  /** Audit every active claim; no git needed. */
  all?: boolean;
}

export interface CheckRecordRef {
  id: string;
  type: MemoryType | undefined;
  title: string;
  /** Relative to the repo top in git mode, to the store's parent directory with `--all`. */
  file: string;
}

export type CheckPairStatus = 'unacknowledged' | 'declared_conflict';

export interface CheckSignals {
  shared_anchor: string[];
  path_mention: string[];
  title_terms: string[];
  overlap: number;
}

export interface CheckPair {
  /** The checked (changed) record. */
  a: CheckRecordRef;
  b: CheckRecordRef;
  status: CheckPairStatus;
  signals: CheckSignals;
}

export interface CheckInvalid {
  file: string;
  reason: string;
}

export interface CheckReport {
  ok: boolean;
  mode: 'git' | 'all';
  base?: string;
  merge_base?: string;
  store: string;
  /** Ids of the active claims whose content changed (git mode) or every active claim (`--all`). */
  checked: string[];
  /** Changed active-claim files whose title, body and anchored files equal the base version. */
  skipped_unchanged_content: number;
  pairs: CheckPair[];
  invalid: CheckInvalid[];
}

function realpathSafe(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

function anchorKey(repo: string | undefined, file: string): string {
  return `${repo ?? ''}\0${file}`;
}

function anchorLabel(key: string): string {
  const [repo, file] = key.split('\0');
  return repo ? `${repo}:${file}` : file;
}

/**
 * Claim content for the "did this record really change" test: normalised
 * title, body, and the SET of anchored files (repo + file, not the sha). Every
 * other field is frontmatter bookkeeping (verification, TTLs, tags, scope,
 * edges): a triage PR that re-verifies thirty records must not put them all
 * in the changed set.
 */
export function claimContentKey(item: Pick<MemoryItem, 'title' | 'body' | 'anchors'>): string {
  const body = item.body
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
  const anchors = [...new Set((item.anchors ?? []).map((a) => anchorKey(a.repo, a.file)))].sort();
  return JSON.stringify([normaliseTitle(item.title), body, anchors]);
}

/** Raw title words that carry topical signal: lowercased, edge punctuation trimmed, short words and stopwords dropped. */
function contentTitleWords(title: string): string[] {
  return title
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter((label) => label.length >= TITLE_WORD_MIN_LENGTH && !COVERAGE_STOPWORDS.has(label));
}

/**
 * Title-term sets for every active claim, tokenised in ONE pass with the index
 * tokenizer (unicode61 + porter), so `invoices` and `invoice` agree. Tokens
 * carrying a digit are dropped (ids, years, versions), then, in a store large
 * enough for frequency to mean something, tokens that occur in more than
 * `DF_FILTER_MAX_FRACTION` of active-claim titles (the project's own name,
 * its domain noun) are dropped too.
 */
export function computeTitleTerms(titles: string[]): Array<Set<string>> {
  const tokenised = tokenizeLikeIndex(titles.map((t) => contentTitleWords(t).join(' ')));
  const sets = tokenised.map((tokens) => new Set(tokens.filter((t) => !/\p{N}/u.test(t))));
  if (titles.length >= DF_FILTER_MIN_CLAIMS) {
    const df = new Map<string, number>();
    for (const set of sets) for (const t of set) df.set(t, (df.get(t) ?? 0) + 1);
    const limit = titles.length * DF_FILTER_MAX_FRACTION;
    for (const set of sets) {
      for (const t of [...set]) if ((df.get(t) ?? 0) > limit) set.delete(t);
    }
  }
  return sets;
}

export interface CheckProfile {
  item: MemoryItem;
  anchorKeys: Set<string>;
  anchorPaths: Set<string>;
  terms: Set<string>;
  text: string;
}

/** Signals for a pair, and whether the pair rule flags it. */
function pairSignals(x: CheckProfile, y: CheckProfile): { signals: CheckSignals; flagged: boolean } {
  const sharedAnchor = [...x.anchorKeys].filter((k) => y.anchorKeys.has(k)).map(anchorLabel).sort();
  const mentions = new Set<string>();
  for (const p of y.anchorPaths) if (x.text.includes(p)) mentions.add(p);
  for (const p of x.anchorPaths) if (y.text.includes(p)) mentions.add(p);
  const pathMention = [...mentions].sort();
  const shared = [...x.terms].filter((t) => y.terms.has(t)).sort();
  const smaller = Math.min(x.terms.size, y.terms.size);
  const overlap = smaller === 0 ? 0 : shared.length / smaller;
  const fileSignal = sharedAnchor.length > 0 || pathMention.length > 0;
  const flagged = (fileSignal && shared.length >= FILE_SIGNAL_MIN_SHARED_TERMS)
    || (shared.length >= TITLE_ONLY_MIN_SHARED_TERMS && overlap >= TITLE_ONLY_MIN_OVERLAP);
  return {
    signals: {
      shared_anchor: sharedAnchor,
      path_mention: pathMention,
      title_terms: shared,
      overlap: Math.round(overlap * 1000) / 1000,
    },
    flagged,
  };
}

function edgeList(item: MemoryItem, edge: typeof ACK_EDGES[number]): string[] {
  return (item[edge] as string[] | undefined) ?? [];
}

function profileOf(item: MemoryItem, terms: Set<string>): CheckProfile {
  const anchors = item.anchors ?? [];
  return {
    item,
    anchorKeys: new Set(anchors.map((a) => anchorKey(a.repo, a.file))),
    anchorPaths: new Set(anchors.map((a) => a.file).filter((f) => f.length >= ANCHOR_PATH_MIN_LENGTH)),
    terms,
    text: `${item.title}\n${item.body}`,
  };
}

function resolveStore(options: CheckOptions): MemspecStore {
  const store = options.store
    ? new MemspecStore(resolve(options.cwd ?? process.cwd(), options.store), { walk: false })
    : new MemspecStore(options.cwd);
  if (!store.exists) {
    throw new CheckUsageError(`memspec check: no store at ${store.root}`);
  }
  return store;
}

function splitZ(out: string): string[] {
  return out.split('\0').filter((s) => s.length > 0);
}

interface GitChangeSet {
  top: string;
  baseLabel: string;
  mergeBase: string;
  /** Repo-relative POSIX paths under the store that differ from the merge-base (incl. untracked). */
  changed: string[];
  /** Base-version claim content key for a record id, or null when the record is new at the merge-base. */
  baseContentKey(id: string, relPath: string): string | null;
}

function gitChangeSet(storeRoot: string, base: string | undefined): GitChangeSet {
  const storeReal = realpathSafe(storeRoot);
  const topResult = gitRaw(storeReal, ['rev-parse', '--show-toplevel']);
  const topOut = topResult.ok ? topResult.out.trim() : '';
  if (!topOut) {
    throw new CheckUsageError(
      `memspec check: ${storeRoot} is not inside a git working tree (or git failed); pass --all to audit without git`,
    );
  }
  const top = realpathSafe(topOut);
  const storeRelRaw = relative(top, storeReal);
  if (storeRelRaw.startsWith('..') || isAbsolute(storeRelRaw)) {
    throw new CheckUsageError(`memspec check: store ${storeRoot} is outside its git working tree ${top}`);
  }
  const storeRel = storeRelRaw === '' ? '.' : toPosix(storeRelRaw);

  let baseLabel: string;
  let baseSha: string;
  if (base !== undefined) {
    const r = gitRaw(top, ['rev-parse', '--verify', '-q', `${base}^{commit}`]);
    const sha = r.ok ? r.out.trim() : '';
    if (!sha) throw new CheckUsageError(`memspec check: base ref "${base}" does not resolve to a commit in ${top}`);
    baseLabel = base;
    baseSha = sha;
  } else {
    const def = defaultBranchOf(top);
    if (!def) {
      throw new CheckUsageError(
        `memspec check: cannot determine the default branch of ${top} (no origin/HEAD, origin/main or origin/master); pass --base <ref>`,
      );
    }
    baseLabel = def.ref;
    baseSha = def.sha;
  }

  const mbResult = gitRaw(top, ['merge-base', baseSha, 'HEAD']);
  const mergeBase = mbResult.ok ? mbResult.out.trim() : '';
  if (!mergeBase) {
    throw new CheckUsageError(`memspec check: no merge-base between ${baseLabel} and HEAD in ${top}`);
  }

  // `--literal-pathspecs`: the store path is a path, never a glob (a parent
  // directory named `[x]` must not turn into a character class).
  const diff = gitRaw(top, ['--literal-pathspecs', 'diff', '--name-only', '-z', '--no-renames', '--diff-filter=d', mergeBase, '--', storeRel]);
  if (!diff.ok) throw new CheckUsageError(`memspec check: git diff against ${mergeBase} failed in ${top}`);
  const untracked = gitRaw(top, ['--literal-pathspecs', 'ls-files', '-z', '--others', '--exclude-standard', '--', storeRel]);
  if (!untracked.ok) throw new CheckUsageError(`memspec check: git ls-files failed in ${top}`);
  const changed = [...new Set([...splitZ(diff.out), ...splitZ(untracked.out)])].sort();

  // Base versions are found by record id (`<id>.md`), not by path: a record
  // moved between directories (tier change, archive) is still the same record.
  let baseByName: Map<string, string[]> | null = null;
  const baseIndex = (): Map<string, string[]> => {
    if (baseByName) return baseByName;
    const tree = gitRaw(top, ['--literal-pathspecs', 'ls-tree', '-r', '-z', '--name-only', mergeBase, '--', storeRel]);
    if (!tree.ok) throw new CheckUsageError(`memspec check: git ls-tree ${mergeBase} failed in ${top}`);
    baseByName = new Map();
    for (const path of splitZ(tree.out)) {
      if (!path.endsWith('.md')) continue;
      const name = basename(path, '.md');
      const list = baseByName.get(name) ?? [];
      list.push(path);
      baseByName.set(name, list);
    }
    return baseByName;
  };

  const baseContentKey = (id: string, relPath: string): string | null => {
    const candidates = baseIndex().get(id) ?? [];
    if (candidates.length === 0) return null;
    const path = candidates.includes(relPath) ? relPath : candidates[0];
    const shown = gitRaw(top, ['show', `${mergeBase}:${path}`]);
    if (!shown.ok) throw new CheckUsageError(`memspec check: git show ${mergeBase}:${path} failed in ${top}`);
    try {
      const parsed = parseMemoryFile(shown.out, path);
      if (parsed.id !== id) return null;
      return claimContentKey(parsed);
    } catch {
      // A base version that no longer parses cannot vouch for "unchanged".
      return null;
    }
  };

  return { top, baseLabel, mergeBase, changed, baseContentKey };
}

/**
 * Run the check. Throws `CheckUsageError` for usage/git problems (exit 2);
 * returns a report whose `ok` is false when there are findings (exit 1).
 */
export function runCheck(options: CheckOptions = {}): CheckReport {
  if (options.all && options.base !== undefined) {
    throw new CheckUsageError('memspec check: --all audits the whole store; it does not take --base');
  }
  const store = resolveStore(options);
  const storeReal = realpathSafe(store.root);

  const all = store.loadAll();
  const warnings = [...store.warnings];
  const activeClaims = all
    .filter((item) => item.kind === 'claim' && item.state === 'active')
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const activeById = new Map(activeClaims.map((item) => [item.id, item]));
  const questions = all.filter((item) => item.kind === 'question');

  const byRealPath = new Map<string, MemoryItem>();
  for (const item of all) byRealPath.set(realpathSafe(item.filePath), item);
  const warningByRealPath = new Map<string, string>();
  for (const w of warnings) warningByRealPath.set(realpathSafe(w.file), w.reason);

  const memoryRoot = join(storeReal, 'memory') + sep;
  const isUnderMemory = (real: string): boolean => real.startsWith(memoryRoot) && real.endsWith('.md');

  let mode: CheckReport['mode'];
  let displayRoot: string;
  let baseLabel: string | undefined;
  let mergeBase: string | undefined;
  /** Active claims whose FILE changed (any edit): feeds the declared-conflict rule. */
  let changedFileClaims: MemoryItem[];
  /** Active claims whose CONTENT changed: feeds the pair-signal rule. */
  let contentChanged: MemoryItem[];
  let skipped = 0;
  const invalid: CheckInvalid[] = [];

  if (options.all) {
    mode = 'all';
    displayRoot = dirname(storeReal);
    changedFileClaims = activeClaims;
    contentChanged = activeClaims;
    for (const [real, reason] of warningByRealPath) {
      if (isUnderMemory(real)) invalid.push({ file: toPosix(relative(displayRoot, real)), reason });
    }
  } else {
    mode = 'git';
    const changes = gitChangeSet(store.root, options.base);
    displayRoot = changes.top;
    baseLabel = changes.baseLabel;
    mergeBase = changes.mergeBase;
    changedFileClaims = [];
    contentChanged = [];
    const seen = new Set<string>();
    for (const rel of changes.changed) {
      const real = realpathSafe(join(changes.top, rel));
      const warning = warningByRealPath.get(real);
      if (warning !== undefined) {
        if (isUnderMemory(real)) invalid.push({ file: rel, reason: warning });
        continue;
      }
      const item = byRealPath.get(real);
      if (!item) {
        // A record file the loader did not keep: its id duplicates another file's.
        if (isUnderMemory(real)) {
          invalid.push({ file: rel, reason: 'not loaded: its record id duplicates another record file in this store' });
        }
        continue;
      }
      if (item.kind !== 'claim' || item.state !== 'active' || seen.has(item.id)) continue;
      seen.add(item.id);
      changedFileClaims.push(item);
      const baseKey = changes.baseContentKey(item.id, rel);
      if (baseKey !== null && baseKey === claimContentKey(item)) {
        skipped++;
        continue;
      }
      contentChanged.push(item);
    }
    contentChanged.sort((a, b) => (a.id < b.id ? -1 : 1));
    changedFileClaims.sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  const refOf = (item: MemoryItem): CheckRecordRef => ({
    id: item.id,
    type: item.type,
    title: item.title,
    file: toPosix(relative(displayRoot, realpathSafe(item.filePath))),
  });

  const pairs: CheckPair[] = [];
  const pairKeys = new Set<string>();
  const keyOf = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

  const inQuestionTogether = (a: string, b: string): boolean =>
    questions.some((q) => (q.answers ?? []).includes(a) && (q.answers ?? []).includes(b));
  const declaresConflict = (x: MemoryItem, y: MemoryItem): boolean =>
    (x.conflicts_with ?? []).includes(y.id) || (y.conflicts_with ?? []).includes(x.id);
  const acknowledged = (x: MemoryItem, y: MemoryItem): boolean =>
    ACK_EDGES.some((edge) => edgeList(x, edge).includes(y.id) || edgeList(y, edge).includes(x.id));

  const needProfiles = contentChanged.length > 0 || changedFileClaims.some((c) => (c.conflicts_with ?? []).length > 0);
  const profiles = new Map<string, CheckProfile>();
  if (needProfiles) {
    const termSets = computeTitleTerms(activeClaims.map((c) => c.title));
    activeClaims.forEach((item, i) => profiles.set(item.id, profileOf(item, termSets[i])));
  }

  // Declared conflicts: a changed FILE (frontmatter-only edits included) that
  // carries conflicts_with to another ACTIVE record is a known contradiction
  // about to sit in the store, signal or no signal. Only a question group
  // filing both answers (or retiring one side) clears it.
  for (const x of changedFileClaims) {
    for (const targetId of x.conflicts_with ?? []) {
      const y = activeById.get(targetId);
      if (!y || y.id === x.id) continue;
      if (inQuestionTogether(x.id, y.id)) continue;
      const key = keyOf(x.id, y.id);
      if (pairKeys.has(key)) continue;
      pairKeys.add(key);
      pairs.push({
        a: refOf(x),
        b: refOf(y),
        status: 'declared_conflict',
        signals: pairSignals(profiles.get(x.id)!, profiles.get(y.id)!).signals,
      });
    }
  }

  // Pair signal: each content-changed record against every other active claim.
  const minShared = Math.min(FILE_SIGNAL_MIN_SHARED_TERMS, TITLE_ONLY_MIN_SHARED_TERMS);
  for (const x of contentChanged) {
    const px = profiles.get(x.id)!;
    for (const y of activeClaims) {
      if (y.id === x.id) continue;
      const key = keyOf(x.id, y.id);
      if (pairKeys.has(key)) continue;
      const py = profiles.get(y.id)!;
      // Both rules need shared title terms: skip the path scans when too few.
      let shared = 0;
      for (const t of px.terms) if (py.terms.has(t)) shared++;
      if (shared < minShared) continue;
      const { signals, flagged } = pairSignals(px, py);
      if (!flagged) continue;
      pairKeys.add(key);
      if (inQuestionTogether(x.id, y.id)) continue;
      let status: CheckPairStatus;
      if (declaresConflict(x, y)) status = 'declared_conflict';
      else if (acknowledged(x, y)) continue;
      else status = 'unacknowledged';
      pairs.push({ a: refOf(x), b: refOf(y), status, signals });
    }
  }

  invalid.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

  return {
    ok: pairs.length === 0 && invalid.length === 0,
    mode,
    ...(baseLabel !== undefined ? { base: baseLabel } : {}),
    ...(mergeBase !== undefined ? { merge_base: mergeBase } : {}),
    store: toPosix(relative(displayRoot, storeReal)) || '.',
    checked: contentChanged.map((item) => item.id),
    skipped_unchanged_content: skipped,
    pairs,
    invalid,
  };
}

function describeRef(ref: CheckRecordRef): string {
  return `${ref.id} (${ref.type ?? 'claim'}) "${ref.title}"  ${ref.file}`;
}

/** Text rendering: one block per finding, the resolution menu once, and a summary line. */
export function renderCheckText(report: CheckReport): string {
  const lines: string[] = [];
  lines.push(
    report.mode === 'git'
      ? `memspec check: store ${report.store}, base ${report.base} (merge-base ${report.merge_base?.slice(0, 12)})`
      : `memspec check: store ${report.store}, auditing every active claim (--all)`,
  );
  if (report.mode === 'git' && report.skipped_unchanged_content > 0) {
    lines.push(`Skipped ${report.skipped_unchanged_content} changed record file(s) with frontmatter-only edits (title, body and anchored files unchanged).`);
  }

  for (const pair of report.pairs) {
    lines.push('');
    lines.push(pair.status === 'declared_conflict' ? 'DECLARED CONFLICT (both records active)' : 'UNACKNOWLEDGED OVERLAP');
    lines.push(`  ${describeRef(pair.a)}`);
    lines.push(`  ${describeRef(pair.b)}`);
    const s = pair.signals;
    if (s.shared_anchor.length > 0) lines.push(`  shared anchor: ${s.shared_anchor.join(', ')}`);
    if (s.path_mention.length > 0) lines.push(`  path mention:  ${s.path_mention.join(', ')}`);
    if (s.title_terms.length > 0) lines.push(`  title terms:   ${s.title_terms.join(', ')} (overlap ${s.overlap.toFixed(2)})`);
  }

  for (const bad of report.invalid) {
    lines.push('');
    lines.push('INVALID RECORD FILE');
    lines.push(`  ${bad.file}: ${bad.reason}`);
  }

  if (report.pairs.length > 0) {
    const first = report.pairs[0];
    const x = first.a.id;
    const y = first.b.id;
    lines.push('');
    lines.push(`Record how each pair relates (ids filled in for the first finding):`);
    lines.push(`  same claim, one is newer   memspec supersede <old> --reason "..."  (or merge both: memspec supersede ${x} --merge-from ${y} --reason "...")`);
    lines.push(`  compatible and related     memspec relate --from ${x} --to ${y} --type refines|supports|depends_on|derived_from`);
    lines.push(`  genuinely disputed         memspec question "<title>" --answers ${x} ${y}`);
    lines.push(`  compared and independent   memspec relate --from ${x} --to ${y} --type distinct_from`);
    if (report.pairs.some((p) => p.status === 'declared_conflict')) {
      lines.push(`  A declared conflict between two active records clears only by superseding one or filing both in a question group.`);
    }
  }

  const findings = report.pairs.length + report.invalid.length;
  lines.push('');
  lines.push(
    findings === 0
      ? `memspec check: ${report.checked.length} record(s) checked, ok`
      : `memspec check: ${report.checked.length} record(s) checked, ${findings} finding(s)`,
  );
  return lines.join('\n');
}
