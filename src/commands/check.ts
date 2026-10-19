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

import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseMemoryFile } from '../lib/frontmatter.js';
import { tokenizeLikeIndex } from '../lib/fts.js';
import { defaultBranchOf, gitRaw } from '../lib/git-state.js';
import { normaliseTitle } from '../lib/inference.js';
import { COVERAGE_STOPWORDS } from '../lib/stopwords.js';
import { MemspecStore, type DuplicateId } from '../lib/store.js';
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
/** Only this many leading characters of a title are tokenised (a title that long is malformed anyway). */
export const TITLE_TOKENISE_MAX_CHARS = 500;
/** The document-frequency filter applies only to stores with at least this many active claims. */
export const DF_FILTER_MIN_CLAIMS = 40;
/** A title term occurring in more than this fraction of active-claim titles is dropped. */
export const DF_FILTER_MAX_FRACTION = 0.05;

/**
 * Edge lists that acknowledge an overlap (either record, either direction).
 * `conflicts_with` does not (a declared conflict), and neither does
 * `supersedes`: a survivor listing a target that is still ACTIVE is a
 * supersede nobody applied (`unapplied_supersede`), not an acknowledgement.
 */
const ACK_EDGES = ['refines', 'supports', 'depends_on', 'derived_from', 'distinct_from'] as const;

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

export type CheckPairStatus = 'unacknowledged' | 'declared_conflict' | 'unapplied_supersede';

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
  /** Changed active-claim files whose claim content, state and acknowledgements equal the base version. */
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
 * title, body, the SET of anchored files (repo + file, not the sha), type,
 * the validity window and scope. Everything else is frontmatter bookkeeping
 * (verification, TTLs, tags, edges): a triage PR that re-verifies thirty
 * records must not put them all in the changed set. State and removed
 * acknowledgements are judged separately (see `baseVouchesUnchanged`).
 */
export function claimContentKey(
  item: Pick<MemoryItem, 'title' | 'body' | 'anchors' | 'type' | 'valid_from' | 'valid_to' | 'scope'>,
): string {
  const body = item.body
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
  const anchors = [...new Set((item.anchors ?? []).map((a) => anchorKey(a.repo, a.file)))].sort();
  return JSON.stringify([
    normaliseTitle(item.title),
    body,
    anchors,
    item.type ?? null,
    item.valid_from ?? null,
    item.valid_to ?? null,
    item.scope ?? null,
  ]);
}

const LETTER_OR_NUMBER = /^[\p{L}\p{N}]$/u;

/**
 * Strip leading and trailing code points that are neither letters nor
 * numbers. Same result as `/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu` but linear:
 * that regex backtracks quadratically on a long punctuation run.
 */
function trimToLettersAndNumbers(word: string): string {
  const points = Array.from(word);
  let start = 0;
  while (start < points.length && !LETTER_OR_NUMBER.test(points[start])) start++;
  let end = points.length;
  while (end > start && !LETTER_OR_NUMBER.test(points[end - 1])) end--;
  return start === 0 && end === points.length ? word : points.slice(start, end).join('');
}

/** Raw title words that carry topical signal: lowercased, edge punctuation trimmed, short words and stopwords dropped. */
function contentTitleWords(title: string): string[] {
  return title
    .slice(0, TITLE_TOKENISE_MAX_CHARS)
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map(trimToLettersAndNumbers)
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

/** The directories the store loader reads records from. */
const RECORD_DIRS = ['memory', 'observations', 'archive'] as const;

function lstatSafe(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new CheckUsageError(`memspec check: cannot stat ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function isSymlink(path: string): boolean {
  return lstatSafe(path)?.isSymbolicLink() ?? false;
}

/**
 * Git mode refuses a store whose root, or anything under its record
 * directories, is a symlink. The loader follows a symlinked directory
 * (`memory -> ../notes`) while git sees one link blob under the store
 * pathspec, so every record behind it would be invisible to the change set.
 */
function assertNoSymlinks(storeRoot: string): void {
  const refuse = (path: string): never => {
    throw new CheckUsageError(
      `memspec check: ${path} is a symlink; git mode refuses symlinks at the store root and under memory/, observations/ and archive/ ` +
        '(git diffs the link, not the records behind it). Replace it with the real files, or audit with --all',
    );
  };
  if (isSymlink(storeRoot)) refuse(storeRoot);
  const walk = (dir: string): void => {
    const st = lstatSafe(dir);
    if (!st) return;
    if (st.isSymbolicLink()) refuse(dir);
    if (!st.isDirectory()) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) refuse(full);
      if (entry.isDirectory()) walk(full);
    }
  };
  for (const dir of RECORD_DIRS) walk(join(storeRoot, dir));
}

interface GitChangeSet {
  top: string;
  baseLabel: string;
  mergeBase: string;
  /** Repo-relative POSIX paths under the store that differ from the merge-base (incl. untracked), deletions excluded. */
  changed: string[];
  /** Repo-relative POSIX paths under the store that exist at the merge-base and are gone now. */
  deleted: string[];
  /**
   * The base version of record `id` (the file `<id>.md` at the merge-base,
   * preferring `relPath`), or null when the record is new, the base copy is
   * ambiguous (several files, none at `relPath`), does not parse, or carries
   * another id.
   */
  baseById(id: string, relPath: string): MemoryItem | null;
  /** The base version of the file at `relPath`, or null when it is absent there or does not parse. */
  baseAt(relPath: string): MemoryItem | null;
}

function gitChangeSet(store: MemspecStore, base: string | undefined): GitChangeSet {
  const storeRoot = store.root;
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

  assertNoSymlinks(storeRoot);

  // A store git never tracks (gitignored, or --store pointing at an untracked
  // copy) would read as "nothing changed": fail closed instead. "Tracked" is
  // any record file in the index, so a change set that moves every record
  // (index still lists the old paths, or the new ones once staged) is fine,
  // and untracked NEW files in a tracked store still count as changed below.
  const recordFiles = store.recordFiles();
  if (recordFiles.length > 0) {
    const tracked = gitRaw(top, ['--literal-pathspecs', 'ls-files', '-z', '--cached', '--', storeRel]);
    if (!tracked.ok) throw new CheckUsageError(`memspec check: git ls-files failed in ${top}`);
    const prefix = storeRel === '.' ? '' : `${storeRel}/`;
    const anyTracked = splitZ(tracked.out).some(
      (path) => path.endsWith('.md') && RECORD_DIRS.some((dir) => path.startsWith(`${prefix}${dir}/`)),
    );
    if (!anyTracked) {
      throw new CheckUsageError(
        `memspec check: none of the ${recordFiles.length} record file(s) in ${storeRoot} is tracked by git ` +
          '(is the store gitignored, or does --store point at the wrong directory?); commit the store, or audit with --all',
      );
    }
  }

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
  const removed = gitRaw(top, ['--literal-pathspecs', 'diff', '--name-only', '-z', '--no-renames', '--diff-filter=D', mergeBase, '--', storeRel]);
  if (!removed.ok) throw new CheckUsageError(`memspec check: git diff against ${mergeBase} failed in ${top}`);
  const untracked = gitRaw(top, ['--literal-pathspecs', 'ls-files', '-z', '--others', '--exclude-standard', '--', storeRel]);
  if (!untracked.ok) throw new CheckUsageError(`memspec check: git ls-files failed in ${top}`);
  const changed = [...new Set([...splitZ(diff.out), ...splitZ(untracked.out)])].sort();
  const deleted = [...new Set(splitZ(removed.out))].sort();

  // Base versions are found by record id (`<id>.md`), not by path: a record
  // moved between directories (tier change, archive) is still the same record.
  let basePaths: Set<string> | null = null;
  let baseByName: Map<string, string[]> | null = null;
  const baseIndex = (): Map<string, string[]> => {
    if (baseByName) return baseByName;
    const tree = gitRaw(top, ['--literal-pathspecs', 'ls-tree', '-r', '-z', '--name-only', mergeBase, '--', storeRel]);
    if (!tree.ok) throw new CheckUsageError(`memspec check: git ls-tree ${mergeBase} failed in ${top}`);
    basePaths = new Set();
    baseByName = new Map();
    for (const path of splitZ(tree.out)) {
      if (!path.endsWith('.md')) continue;
      basePaths.add(path);
      const name = basename(path, '.md');
      const list = baseByName.get(name) ?? [];
      list.push(path);
      baseByName.set(name, list);
    }
    return baseByName;
  };

  const parsedAt = new Map<string, MemoryItem | null>();
  const baseAt = (relPath: string): MemoryItem | null => {
    baseIndex();
    if (!basePaths!.has(relPath)) return null;
    if (parsedAt.has(relPath)) return parsedAt.get(relPath)!;
    const shown = gitRaw(top, ['show', `${mergeBase}:${relPath}`]);
    if (!shown.ok) throw new CheckUsageError(`memspec check: git show ${mergeBase}:${relPath} failed in ${top}`);
    let parsed: MemoryItem | null;
    try {
      // The shared YAML-only parser: base content is as untrusted as the PR's.
      parsed = parseMemoryFile(shown.out, relPath);
    } catch {
      // A base version that no longer parses cannot vouch for anything.
      parsed = null;
    }
    parsedAt.set(relPath, parsed);
    return parsed;
  };

  const baseById = (id: string, relPath: string): MemoryItem | null => {
    const candidates = baseIndex().get(id) ?? [];
    let path: string;
    if (candidates.includes(relPath)) path = relPath;
    else if (candidates.length === 1) path = candidates[0];
    else return null;
    const parsed = baseAt(path);
    return parsed && parsed.id === id ? parsed : null;
  };

  return { top, baseLabel, mergeBase, changed, deleted, baseById, baseAt };
}

/** Every id the record's acknowledging edge lists name. */
function ackTargets(item: MemoryItem): Set<string> {
  const out = new Set<string>();
  for (const edge of ACK_EDGES) for (const id of edgeList(item, edge)) out.add(id);
  return out;
}

/**
 * A changed active claim may be skipped as "frontmatter-only" only when its
 * base version was an ACTIVE CLAIM (a reactivated archive record, a retired
 * one revived, or an observation turned claim is new content here), the claim
 * content is equal, and no acknowledgement the base version carried to a
 * still-active claim was removed (removing an edge is how a PR un-acknowledges
 * a pair; an edge to a record that is no longer active acknowledges nothing).
 */
function baseVouchesUnchanged(base: MemoryItem, item: MemoryItem, activeById: Map<string, MemoryItem>): boolean {
  if (base.kind !== 'claim' || base.state !== 'active') return false;
  if (claimContentKey(base) !== claimContentKey(item)) return false;
  const now = ackTargets(item);
  for (const id of ackTargets(base)) {
    if (!now.has(id) && activeById.has(id)) return false;
  }
  return true;
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

  // Git preconditions (symlinks, tracked store, base resolution) run before
  // the store is loaded.
  const changes = options.all ? null : gitChangeSet(store, options.base);

  const all = store.loadAll();
  const warnings = [...store.warnings];
  const activeClaims = all
    .filter((item) => item.kind === 'claim' && item.state === 'active')
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const activeById = new Map(activeClaims.map((item) => [item.id, item]));
  const questions = all.filter((item) => item.kind === 'question');
  const questionsById = new Map(questions.map((item) => [item.id, item]));

  const byRealPath = new Map<string, MemoryItem>();
  for (const item of all) byRealPath.set(realpathSafe(item.filePath), item);
  const warningByRealPath = new Map<string, string>();
  for (const w of warnings) warningByRealPath.set(realpathSafe(w.file), w.reason);
  const duplicateByRealPath = new Map<string, DuplicateId>();
  for (const dup of store.duplicateIds) for (const file of dup.files) duplicateByRealPath.set(realpathSafe(file), dup);

  const recordRoots = RECORD_DIRS.map((dir) => join(storeReal, dir) + sep);
  const isRecordFile = (real: string): boolean => real.endsWith('.md') && recordRoots.some((root) => real.startsWith(root));

  const mode: CheckReport['mode'] = changes ? 'git' : 'all';
  const displayRoot = changes ? changes.top : dirname(storeReal);
  const displayOf = (path: string): string => toPosix(relative(displayRoot, realpathSafe(path)));

  const invalid: CheckInvalid[] = [];
  const invalidKeys = new Set<string>();
  const addInvalid = (file: string, reason: string): void => {
    const key = `${file}\0${reason}`;
    if (invalidKeys.has(key)) return;
    invalidKeys.add(key);
    invalid.push({ file, reason });
  };
  const reportDuplicate = (dup: DuplicateId): void => {
    const files = dup.files.map(displayOf).sort();
    const reason = `duplicate record id ${dup.id}: ${files.length} files carry it (${files.join(', ')}); the store loads only one`;
    for (const file of files) addInvalid(file, reason);
  };

  const acknowledged = (x: MemoryItem, y: MemoryItem): boolean =>
    ACK_EDGES.some((edge) => edgeList(x, edge).includes(y.id) || edgeList(y, edge).includes(x.id));

  /** Active claims whose FILE changed (any edit): feeds the declared-conflict and unapplied-supersede rules. */
  let changedFileClaims: MemoryItem[];
  /** Active claims whose CONTENT changed (or that lost an acknowledgement): feeds the pair-signal rule. */
  let contentChanged: MemoryItem[];
  let skipped = 0;

  if (!changes) {
    changedFileClaims = activeClaims;
    contentChanged = activeClaims;
    for (const [real, reason] of warningByRealPath) {
      if (isRecordFile(real)) addInvalid(displayOf(real), reason);
    }
    for (const dup of store.duplicateIds) reportDuplicate(dup);
  } else {
    const changedFiles: MemoryItem[] = [];
    const contentIds = new Set<string>();
    const skippedIds = new Set<string>();
    const seen = new Set<string>();
    for (const rel of changes.changed) {
      const abs = join(changes.top, rel);
      if (isSymlink(abs)) {
        addInvalid(rel, 'symlink: files under the store must be regular files (git mode does not follow links)');
        continue;
      }
      const real = realpathSafe(abs);
      const dup = duplicateByRealPath.get(real);
      if (dup) reportDuplicate(dup);
      const warning = warningByRealPath.get(real);
      if (warning !== undefined) {
        if (isRecordFile(real)) addInvalid(rel, warning);
        continue;
      }
      const item = byRealPath.get(real);
      if (!item) {
        if (isRecordFile(real) && !dup) addInvalid(rel, 'not loaded by the store');
        continue;
      }
      if (item.kind !== 'claim' || item.state !== 'active' || seen.has(item.id)) continue;
      seen.add(item.id);
      changedFiles.push(item);
      const base = changes.baseById(item.id, rel);
      if (base && baseVouchesUnchanged(base, item, activeById)) skippedIds.add(item.id);
      else contentIds.add(item.id);
    }

    // Acknowledgements lost by a change OUTSIDE the record itself.
    const deleted = new Set(changes.deleted);
    for (const rel of [...changes.changed, ...changes.deleted]) {
      if (!rel.endsWith('.md')) continue;
      const base = changes.baseAt(rel);
      if (!base) continue;
      if (base.kind === 'question') {
        // A question group changed or deleted: every answer it filed at the
        // base that it no longer files lost that acknowledgement.
        const current = questionsById.get(base.id);
        const still = new Set(current?.answers ?? []);
        for (const id of base.answers ?? []) {
          if (!still.has(id) && activeById.has(id)) contentIds.add(id);
        }
      } else if (deleted.has(rel) && base.kind === 'claim' && base.state === 'active') {
        // A deleted claim file whose record id still loads (another file
        // carries it) without the acknowledgement this file carried: the
        // targets it acknowledged go back into the checked set. When the id
        // no longer loads as an active claim, no pair with it can exist.
        const x = activeById.get(base.id);
        if (!x) continue;
        for (const id of ackTargets(base)) {
          const y = activeById.get(id);
          if (y && y.id !== x.id && !acknowledged(x, y)) contentIds.add(id);
        }
      }
    }

    changedFileClaims = changedFiles.sort((a, b) => (a.id < b.id ? -1 : 1));
    contentChanged = activeClaims.filter((item) => contentIds.has(item.id));
    skipped = [...skippedIds].filter((id) => !contentIds.has(id)).length;
  }

  const refOf = (item: MemoryItem): CheckRecordRef => ({
    id: item.id,
    type: item.type,
    title: item.title,
    file: displayOf(item.filePath),
  });

  const pairs: CheckPair[] = [];
  const pairKeys = new Set<string>();
  const keyOf = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

  const inQuestionTogether = (a: string, b: string): boolean =>
    questions.some((q) => (q.answers ?? []).includes(a) && (q.answers ?? []).includes(b));
  const declaresConflict = (x: MemoryItem, y: MemoryItem): boolean =>
    (x.conflicts_with ?? []).includes(y.id) || (y.conflicts_with ?? []).includes(x.id);

  const profiles = new Map<string, CheckProfile>();
  if (contentChanged.length > 0 || changedFileClaims.length > 0) {
    const termSets = computeTitleTerms(activeClaims.map((c) => c.title));
    activeClaims.forEach((item, i) => profiles.set(item.id, profileOf(item, termSets[i])));
  }
  const pushPair = (x: MemoryItem, y: MemoryItem, status: CheckPairStatus): void => {
    pairs.push({ a: refOf(x), b: refOf(y), status, signals: pairSignals(profiles.get(x.id)!, profiles.get(y.id)!).signals });
  };

  // Unapplied supersedes: a changed record whose `supersedes` names a record
  // that is still ACTIVE (or an active survivor naming a changed record) means
  // the supersede was never applied to the target: both claims are live.
  const activeSurvivors = new Map<string, MemoryItem[]>();
  for (const item of activeClaims) {
    for (const targetId of item.supersedes ?? []) {
      const list = activeSurvivors.get(targetId) ?? [];
      list.push(item);
      activeSurvivors.set(targetId, list);
    }
  }
  for (const x of changedFileClaims) {
    const others = [
      ...(x.supersedes ?? []).map((id) => activeById.get(id)).filter((y): y is MemoryItem => y !== undefined),
      ...(activeSurvivors.get(x.id) ?? []),
    ];
    for (const y of others) {
      if (y.id === x.id) continue;
      const key = keyOf(x.id, y.id);
      if (pairKeys.has(key)) continue;
      pairKeys.add(key);
      pushPair(x, y, 'unapplied_supersede');
    }
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
      pushPair(x, y, 'declared_conflict');
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

  invalid.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0));

  return {
    ok: pairs.length === 0 && invalid.length === 0,
    mode,
    ...(changes ? { base: changes.baseLabel, merge_base: changes.mergeBase } : {}),
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
    lines.push(`Skipped ${report.skipped_unchanged_content} changed record file(s) with frontmatter-only edits (claim content, state and acknowledgements unchanged).`);
  }

  for (const pair of report.pairs) {
    lines.push('');
    lines.push(
      pair.status === 'declared_conflict'
        ? 'DECLARED CONFLICT (both records active)'
        : pair.status === 'unapplied_supersede'
          ? 'UNAPPLIED SUPERSEDE (both records active)'
          : 'UNACKNOWLEDGED OVERLAP',
    );
    lines.push(`  ${describeRef(pair.a)}`);
    lines.push(`  ${describeRef(pair.b)}`);
    if (pair.status === 'unapplied_supersede') {
      lines.push(
        '  the superseded record is still active; move it to archive/ with state superseded and superseded_by, ' +
          'or let `memspec supersede` do it in this store',
      );
    }
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

  const first = report.pairs.find((p) => p.status !== 'unapplied_supersede');
  if (first) {
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
