import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { decayDaysByType, defaultConfigYaml, loadConfig } from './config.js';
import { findStoreDirUpward } from './registry.js';
import { FtsIndex, type MatchTier } from './fts.js';
import { parseMemoryFile, serializeMemoryFile } from './frontmatter.js';
import { validateFrontmatter, type NormalizeOptions } from './schema.js';
import { effectiveSourceKind, storageTierForSourceKind } from './source.js';
import type { MemoryFrontmatter, MemoryItem, MemoryType } from './types.js';
import { parseFrontMatter } from './safe-matter.js';

/**
 * v0.3: items past check_by are stale at read time, even when the on-disk
 * frontmatter hasn't been touched yet. The flag is computed lazily so callers
 * (search, sweep, status) see the current state without a separate decay run.
 * Files are never mutated here — physical retirement is still `memspec sweep`.
 */
function withLazyStale(item: MemoryItem): MemoryItem {
  if (item.stale) return item;
  // Only active claims age: a superseded/archived record is already resolved,
  // flagging it stale would just re-surface settled history.
  if (item.state !== 'active') return item;
  if (item.check_by === 'never' || !item.check_by) return item;
  if (item.kind === 'observation') return item;
  const expiry = Date.parse(item.check_by);
  if (Number.isNaN(expiry)) return item;
  if (Date.now() <= expiry) return item;
  return { ...item, stale: true };
}

/**
 * Parsed-record cache for long-lived processes (the MCP server). Re-reading
 * and YAML-parsing every record file was ~85% of a warm query on a
 * 2k-record store. Entries are keyed by absolute path and invalidated on any
 * change of (mtime, ctime, size, inode), so an edited, replaced, added or
 * deleted file is picked up by the next load. The stat is taken BEFORE the
 * read: a write racing the read leaves an entry whose key no longer matches,
 * so it is re-read next time rather than cached stale.
 *
 * Cached items are never handed out: every load returns a deep copy, so a
 * caller that mutates a returned record (read-modify-write commands do)
 * cannot corrupt the next load. One map per store root, rebuilt on every
 * load from the files actually present, so deleted files drop out.
 */
interface ParsedRecordEntry {
  mtimeMs: number;
  ctimeMs: number;
  size: number;
  ino: number;
  /** The decay table the record was normalised with; a config edit invalidates. */
  normalizeKey: string;
  /** Parsed record, or the load-warning reason for a file that failed validation/parsing. */
  result: { item: MemoryItem } | { reason: string };
}

const parsedRecordCache = new Map<string, Map<string, ParsedRecordEntry>>();

/**
 * Deep copy of a parsed record. Frontmatter values are YAML scalars, arrays,
 * plain mappings and (inside `ext`) possibly Dates — a hand-rolled walk is
 * several times cheaper than `structuredClone` on the hot path.
 */
function cloneValue<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(cloneValue) as T;
  if (value instanceof Date) return new Date(value.getTime()) as T;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return structuredClone(value);
  const out: Record<string, unknown> = {};
  // defineProperty, not assignment: a parsed `__proto__` key must stay an own
  // property instead of becoming the copy's prototype.
  for (const key of Object.keys(value)) {
    Object.defineProperty(out, key, {
      value: cloneValue((value as Record<string, unknown>)[key]),
      enumerable: true, writable: true, configurable: true,
    });
  }
  return out as T;
}

/** Parse one record file: the item, or the load-warning reason. Pure in (raw, file, normalize). */
function parseRecordFile(raw: string, file: string, normalize: NormalizeOptions): ParsedRecordEntry['result'] {
  try {
    const parsed = parseFrontMatter(raw);
    const data = parsed.data as Record<string, unknown>;

    // Coerce dates before validation (both legacy decay_after and v0.3 check_by)
    for (const key of ['created', 'decay_after', 'check_by', 'last_verified', 'expires']) {
      if (data[key] instanceof Date) {
        data[key] = (data[key] as Date).toISOString();
      }
    }

    const result = validateFrontmatter(data, normalize);
    if (!result.success) {
      return { reason: `Invalid frontmatter: ${result.errors.join('; ')}` };
    }

    return { item: parseMemoryFile(raw, file, normalize) };
  } catch (err) {
    return { reason: err instanceof Error ? err.message : String(err) };
  }
}

function walkMarkdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];

  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkMarkdownFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(fullPath);
    }
  }

  return results;
}

export interface StoreSearchOptions {
  limit?: number;
  types?: MemoryType[];
  /**
   * Active scope. Records are returned when their own `scope` is absent,
   * `universal`, or equal to this value. Undefined disables scope filtering
   * entirely (the state every store without a `scopes:` config is in).
   */
  scope?: string;
  ranking?: {
    relevance?: number;
    confidence?: number;
    recency?: number;
  };
}

export interface LoadWarning {
  file: string;
  reason: string;
}

/** A record id loaded from more than one file (files sorted, so the set does not depend on readdir order). */
export interface DuplicateId {
  id: string;
  files: string[];
}

/**
 * Optional out-parameter for `search`: the strongest raw BM25 score among the
 * returned hits (most negative = best; null when there are no hits). Feeds the
 * search-coverage classifier (DEFECT C) without a second FTS pass.
 */
export interface SearchRelevanceMeta {
  topBm25: number | null;
  /**
   * Match tier of every returned hit, by id (1 = every query term, 2 =
   * partial-term top-up; see `MatchTier`). Set by every search that returns
   * hits; coverage reads it to tell a full match from a page of partials.
   */
  tiers?: Map<string, MatchTier>;
}

/**
 * Files every store's .gitignore must list. These are per-machine telemetry or
 * secrets, never memory: `usage.jsonl` (retrieval log), `outcomes.jsonl`
 * (outcome receipts, auto-written by `supersede` since 0.11), `local/`
 * (trajectories, digests, secrets — `--evidence` refuses to copy from it) and
 * `logs/`. A store synced by `git add -A` would otherwise ship them.
 */
export const REQUIRED_GITIGNORE_ENTRIES = ['usage.jsonl', 'outcomes.jsonl', 'local/', 'logs/'] as const;

const STORE_GITIGNORE_TEMPLATE =
  '# Derived search index — rebuildable from files\n' +
  '*.db\n*.db-journal\n*.db-wal\n.fts.db\n.fts.db-journal\n.fts.db-wal\n' +
  '# Per-clone reconcile checkpoint\n.reconcile.json\n' +
  '# Local retrieval log — boot usage_boost input\nusage.jsonl\n' +
  '# Local outcome receipts (memspec outcome / supersede) — never memory\noutcomes.jsonl\n' +
  '# Machine-local subtree: trajectories, digests, secrets — never committed\nlocal/\n' +
  'logs/\n';

/** `local` and `local/` (or `/local/`) ignore the same directory. */
function gitignoreKey(line: string): string {
  return line.trim().replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * Idempotent: make sure `<storeRoot>/.gitignore` lists every entry in
 * `REQUIRED_GITIGNORE_ENTRIES`. Creates the file from the full template when
 * it is missing; otherwise appends only the entries that are absent (under a
 * short comment), preserving whatever the operator already has. Returns the
 * entries appended (empty when nothing changed). No-op when the store
 * directory itself does not exist — a probe must never conjure a store.
 *
 * Called from `init()` and from every write path (`writeItem`, outcome
 * append), so an existing store gets the 0.11 lines on its first 0.11 write
 * rather than after a manual step.
 */
export function ensureStoreGitignore(storeRoot: string): string[] {
  if (!existsSync(storeRoot)) return [];
  const gitignorePath = join(storeRoot, '.gitignore');
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, STORE_GITIGNORE_TEMPLATE);
    return [...REQUIRED_GITIGNORE_ENTRIES];
  }
  const current = readFileSync(gitignorePath, 'utf8');
  const have = new Set(
    current
      .split('\n')
      .filter((l) => l.trim() !== '' && !l.trimStart().startsWith('#'))
      .map(gitignoreKey),
  );
  const missing = REQUIRED_GITIGNORE_ENTRIES.filter((e) => !have.has(gitignoreKey(e)));
  if (missing.length === 0) return [];
  const prefix = current.length === 0 || current.endsWith('\n') ? '' : '\n';
  writeFileSync(
    gitignorePath,
    current + prefix + '# memspec 0.11: local telemetry, never memory\n' + missing.join('\n') + '\n',
  );
  return missing;
}

export class MemspecStore {
  readonly root: string;
  readonly warnings: LoadWarning[] = [];
  /**
   * Ids that more than one record file carries, refreshed by every load. The
   * loader keeps one copy (operator path wins, else the first file seen) and
   * says so on stderr; `memspec check` reads this to fail a change set that
   * adds a duplicate. Kept out of `warnings` so other commands' output is
   * unchanged.
   */
  readonly duplicateIds: DuplicateId[] = [];
  /**
   * Newest mtime among the `memory/` + `observations/` files seen by the last
   * load (0 when none). Lets `search` judge the FTS cache's freshness from the
   * stats the load already took instead of stat-ing every source file again.
   */
  private activeSourceMaxMtimeMs = 0;

  /**
   * @param root  A store directory (`…/.memspec`) used as-is, or a working
   *   directory that resolves to a store. Undefined resolves from cwd.
   * @param opts.walk  When false, disables the C1 upward walk: `root` is treated
   *   strictly as `<root>/.memspec` (append-only, the pre-C1 behaviour). Used by
   *   `CompositeStore` for explicit layer paths, which must never climb.
   */
  constructor(root?: string, opts?: { walk?: boolean }) {
    if (!root) {
      this.root = this.findRoot();
      return;
    }
    // Idempotent `.memspec` resolution: a path that already points at a store
    // (e.g. MEMSPEC_ROOT=~/.memspec) is used as-is; otherwise `root` is treated
    // as the parent and `.memspec` is appended. This keeps the CLI (`--store
    // global` → homedir) and the MCP server (MEMSPEC_ROOT → store dir) in sync
    // instead of doubling to `~/.memspec/.memspec`.
    const resolved = resolve(root);
    if (basename(resolved) === '.memspec') {
      this.root = resolved; // explicit store dir — used as-is, never walked
      return;
    }
    if (opts?.walk === false) {
      this.root = join(resolved, '.memspec');
      return;
    }
    // C1: an explicit working directory still walks up (bounded to $HOME,
    // opt-out via MEMSPEC_NO_WALK) so a session in a subdirectory — or in a
    // repo with no store of its own — resolves the nearest real store instead
    // of a phantom empty `<cwd>/.memspec`. Falls back to the classic append
    // when nothing is found within bounds.
    this.root = findStoreDirUpward(resolved) ?? join(resolved, '.memspec');
  }

  private findRoot(): string {
    return findStoreDirUpward(process.cwd()) ?? join(process.cwd(), '.memspec');
  }

  get exists(): boolean {
    return existsSync(this.root);
  }

  get configPath(): string {
    return join(this.root, 'config.yaml');
  }

  init(): void {
    const dirs = [
      this.root,
      join(this.root, 'observations'),
      join(this.root, 'memory', 'facts'),
      join(this.root, 'memory', 'decisions'),
      join(this.root, 'memory', 'procedures'),
      join(this.root, 'archive'),
    ];

    for (const dir of dirs) {
      mkdirSync(dir, { recursive: true });
    }

    // Creates the template on a fresh store; appends the 0.11 entries
    // (outcomes.jsonl, local/, logs/) to a pre-0.11 store's existing file.
    ensureStoreGitignore(this.root);

    if (!existsSync(this.configPath)) {
      writeFileSync(this.configPath, defaultConfigYaml());
    }
  }

  typeDir(type: MemoryType): string {
    return join(this.root, 'memory', `${type}s`);
  }

  /**
   * Phase 4: operator-tier records live in a dedicated subtree so storage
   * segregation is visible on disk. Observations are tier-agnostic — they
   * stay in their single directory regardless of source_kind.
   */
  operatorTypeDir(type: MemoryType): string {
    return join(this.root, 'memory', 'operator', `${type}s`);
  }

  observationDir(): string {
    return join(this.root, 'observations');
  }

  private pathForItem(item: MemoryFrontmatter): string {
    if (item.kind === 'observation' || !item.type) {
      return join(this.observationDir(), `${item.id}.md`);
    }
    const tier = storageTierForSourceKind(effectiveSourceKind(item));
    const dir = tier === 'operator' ? this.operatorTypeDir(item.type) : this.typeDir(item.type);
    return join(dir, `${item.id}.md`);
  }

  /**
   * Bumped by every record write through this instance (`writeItem`,
   * `updateItem`, `moveToArchive`). Lets a view that memoizes a derivation of
   * this store's records (`CompositeStore.pendingPromotions`) notice a write.
   */
  get writeGeneration(): number {
    return this.writes;
  }

  private writes = 0;

  writeItem(item: MemoryFrontmatter & { title: string; body: string }): string {
    this.writes++;
    const filePath = this.pathForItem(item);
    const dir = resolve(filePath, '..');
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, serializeMemoryFile(item));
    // Every write path keeps the store's .gitignore current, so a store
    // created before 0.11 picks up `outcomes.jsonl` / `local/` / `logs/` on
    // its first 0.11 write instead of committing telemetry on the next sync.
    ensureStoreGitignore(this.root);
    return filePath;
  }

  /**
   * Project-root markdown files that contribute to FTS. Active items live under
   * memory/ and observations/; archive/ is excluded because superseded/retired
   * records aren't searchable anyway.
   */
  activeSourceFiles(): string[] {
    return [
      ...walkMarkdownFiles(join(this.root, 'memory')),
      ...walkMarkdownFiles(join(this.root, 'observations')),
    ];
  }

  /**
   * Per-type TTLs from this store's `config.yaml` `decay:` block. A config
   * that cannot be read falls back to the built-in defaults: loading records
   * must not fail over a TTL table.
   */
  private configuredDecayDays(): Record<MemoryType, number> | undefined {
    try {
      return decayDaysByType(loadConfig(this.root));
    } catch {
      return undefined;
    }
  }

  /**
   * Raw load — every record in every state, without the lazy stale
   * projection. Feeds the mutation lookup (`findById`): commands that read a
   * record, edit it, and write it back must not bake a computed `stale: true`
   * onto disk as a side effect (`withLazyStale` is a read-time flag, not a
   * stored one). `loadAll()` layers the projection on top for read consumers.
   */
  /** Every markdown file the loader reads: `memory/`, `observations/`, `archive/`, in that order. */
  recordFiles(): string[] {
    return [
      ...walkMarkdownFiles(join(this.root, 'memory')),
      ...walkMarkdownFiles(join(this.root, 'observations')),
      ...walkMarkdownFiles(join(this.root, 'archive')),
    ];
  }

  private loadAllRaw(): MemoryItem[] {
    const files = this.recordFiles();

    this.warnings.length = 0;
    this.duplicateIds.length = 0;
    const filesById = new Map<string, string[]>();
    // Phase 4: collision defence. Same id appearing in both standard and operator
    // paths shouldn't happen, but if it does the operator path wins (more
    // authoritative). Stderr warning so callers notice the drift; no throw.
    const operatorMemoryRoot = join(this.root, 'memory', 'operator');
    const byId = new Map<string, MemoryItem>();
    // The store's own `decay:` TTLs, so a legacy `decay_after: never` reads
    // with the TTL this store configured (see `legacyNeverCheckBy`).
    const normalize = { decayDays: this.configuredDecayDays() };
    const normalizeKey = JSON.stringify(normalize.decayDays ?? null);
    const previous = parsedRecordCache.get(this.root);
    const cache = new Map<string, ParsedRecordEntry>();
    parsedRecordCache.set(this.root, cache);
    const activePrefixes = [join(this.root, 'memory') + sep, join(this.root, 'observations') + sep];
    let activeMaxMtimeMs = 0;

    for (const file of files) {
      try {
        const st = statSync(file, { throwIfNoEntry: false });
        if (!st) continue; // deleted between the walk and now
        if (st.mtimeMs > activeMaxMtimeMs && activePrefixes.some((p) => file.startsWith(p))) {
          activeMaxMtimeMs = st.mtimeMs;
        }
        let entry = previous?.get(file);
        if (
          !entry ||
          entry.mtimeMs !== st.mtimeMs ||
          entry.ctimeMs !== st.ctimeMs ||
          entry.size !== st.size ||
          entry.ino !== st.ino ||
          entry.normalizeKey !== normalizeKey
        ) {
          entry = {
            mtimeMs: st.mtimeMs,
            ctimeMs: st.ctimeMs,
            size: st.size,
            ino: st.ino,
            normalizeKey,
            result: parseRecordFile(readFileSync(file, 'utf8'), file, normalize),
          };
        }
        cache.set(file, entry);
        if ('reason' in entry.result) {
          this.warnings.push({ file, reason: entry.result.reason });
          continue;
        }

        const item = cloneValue(entry.result.item);
        const sameId = filesById.get(item.id);
        if (sameId) sameId.push(file);
        else filesById.set(item.id, [file]);
        const existing = byId.get(item.id);
        if (existing) {
          const incomingIsOperator = file.startsWith(operatorMemoryRoot);
          const existingIsOperator = existing.filePath.startsWith(operatorMemoryRoot);
          if (incomingIsOperator && !existingIsOperator) {
            process.stderr.write(
              `memspec: id collision for ${item.id} between ${existing.filePath} and ${file}; operator path wins.\n`,
            );
            byId.set(item.id, item);
          } else if (!incomingIsOperator && existingIsOperator) {
            process.stderr.write(
              `memspec: id collision for ${item.id} between ${existing.filePath} and ${file}; operator path wins.\n`,
            );
            // Keep existing (operator).
          } else {
            // Same tier — keep first, but surface the duplicate so it's visible.
            process.stderr.write(
              `memspec: duplicate id ${item.id} at ${existing.filePath} and ${file}; keeping first.\n`,
            );
          }
        } else {
          byId.set(item.id, item);
        }
      } catch (err) {
        this.warnings.push({ file, reason: err instanceof Error ? err.message : String(err) });
      }
    }

    for (const [id, idFiles] of filesById) {
      if (idFiles.length > 1) this.duplicateIds.push({ id, files: [...idFiles].sort() });
    }
    this.duplicateIds.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    this.activeSourceMaxMtimeMs = activeMaxMtimeMs;

    return Array.from(byId.values());
  }

  /**
   * All records in all states, with the lazy stale flag applied at the store
   * read path so every consumer (status, sweep, search) sees the current
   * state without a separate decay run. Records past `check_by` read as
   * `stale: true`; files are never mutated here.
   */
  loadAll(): MemoryItem[] {
    return this.loadAllRaw().map(withLazyStale);
  }

  loadActive(): MemoryItem[] {
    return this.loadAll().filter((item) => item.state === 'active');
  }

  /**
   * v0.6 Phase 1 — superseded records, loaded from `archive/`. Used by search
   * when `include_superseded: true` lets the expansion walker reach archived
   * records as targets (seeds stay active-only). Retired records are kept out
   * deliberately: a retraction is a deletion of intent, not a target the
   * walker should follow into.
   */
  loadSuperseded(): MemoryItem[] {
    return this.loadAll().filter((item) => item.state === 'superseded');
  }

  /**
   * Distinct `scope` values stamped on records in any state. Feeds scope-name
   * validation: records are stamped before the `scopes:` config block is
   * written, so the config is not a complete inventory of the scopes that
   * exist. Archived records count too — a scope whose last record was
   * superseded is still a real name, and `--include-superseded` can legitimately
   * ask for it. Callers pass this as a thunk so the walk only happens when the
   * config didn't already settle the question.
   */
  scopesInUse(): string[] {
    if (!this.exists) return [];
    const seen = new Set<string>();
    for (const item of this.loadAll()) {
      if (item.scope) seen.add(item.scope);
    }
    return [...seen];
  }

  findById(id: string): MemoryItem | null {
    // Raw load on purpose: findById is the mutation lookup for verify /
    // anchor / relate / supersede, which write the record back. A lazily
    // computed `stale: true` must not persist as a side effect of an
    // unrelated edit.
    return this.loadAllRaw().find((item) => item.id === id) ?? null;
  }

  moveToArchive(item: MemoryItem, state: MemoryItem['state'] = 'retired'): void {
    this.writes++;
    const archivePath = join(this.root, 'archive', `${item.id}.md`);
    writeFileSync(
      archivePath,
      serializeMemoryFile({
        ...item,
        state,
      }),
    );
    if (item.filePath !== archivePath && existsSync(item.filePath)) {
      unlinkSync(item.filePath);
    }
  }

  updateItem(item: MemoryItem): void {
    this.writes++;
    writeFileSync(item.filePath, serializeMemoryFile(item));
  }

  search(query: string, options: StoreSearchOptions = {}, meta?: SearchRelevanceMeta): MemoryItem[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (meta) {
      meta.topBm25 = null;
      meta.tiers = new Map();
    }
    if (terms.length === 0) return [];

    const {
      limit = 10,
      types,
      scope,
      ranking,
    } = options;

    const activeItems = this.loadActive();

    // mtime-cached on-disk FTS index. Rebuild only when a source file's mtime
    // is newer than the cache — at 200 items the win is invisible, at 5k it's
    // 250ms → 5ms. Canonical truth still lives in markdown files. The load
    // above already stat-ed every source file; its newest mtime decides.
    const cachePath = join(this.root, '.fts.db');
    const fts = FtsIndex.openOrBuild(cachePath, this.activeSourceMaxMtimeMs, activeItems);
    try {
      // `scope` is handed to FTS rather than applied to `matches` on purpose:
      // the candidate pool is `limit * 2` rows wide, so a post-filter would
      // return nothing for a scope whose records rank below the out-of-scope
      // majority.
      const matches = fts.search(query, { limit: limit * 2, types, scope });

      if (matches.length === 0) return [];
      const bm25ById = new Map(matches.map((m) => [m.id, m.bm25Score]));

      const itemMap = new Map(activeItems.map((item) => [item.id, item]));
      const relevanceWeight = ranking?.relevance ?? 1;
      // confidence weight is retained for config compatibility but ignored — the field is gone in v0.3
      const recencyWeight = ranking?.recency ?? 0;
      const now = Date.now();
      const phrase = terms.join(' ');

      // Pre-pass: collect raw FTS + phrase scores so we can normalize per-set
      // before the weighted combination. Raw BM25 sits in the 3–15 range
      // unbounded; without normalization the relevance weight is the only
      // dial that ever moves the ranking. Per-set normalization makes the
      // profile ranking ratios (relevance vs recency) actually apply.
      const rawScored = matches.map(({ id, bm25Score, tier, prefix }) => {
        const item = itemMap.get(id);
        if (!item) return null;

        const ftsScore = -bm25Score;
        const titleLower = item.title.toLowerCase();
        const tagsLower = item.tags.join(' ').toLowerCase();
        const bodyLower = item.body.toLowerCase();
        let phraseBonus = 0;
        if (terms.length > 1) {
          if (titleLower.includes(phrase)) phraseBonus = 5;
          else if (tagsLower.includes(phrase)) phraseBonus = 4;
          else if (bodyLower.includes(phrase)) phraseBonus = 3;
        }
        const rawRelevance = ftsScore + phraseBonus;

        const ageMs = Math.max(0, now - Date.parse(item.created));
        const ageDays = ageMs / (24 * 60 * 60 * 1000);
        const recency = 1 / (1 + ageDays);

        return { item, rawRelevance, recency, tier, prefix: prefix === true };
      }).filter((entry): entry is { item: MemoryItem; rawRelevance: number; recency: number; tier: MatchTier; prefix: boolean } => entry !== null);

      // Per-tier relevance normalization → [0, 1]. recency is already in [0, 1].
      // Per TIER, not per set: a partial-match top-up row with a rare term can
      // out-score every full match on raw BM25, and dividing the full matches
      // by it would reshuffle their order against recency.
      const maxRelevance = new Map<MatchTier, number>();
      for (const r of rawScored) maxRelevance.set(r.tier, Math.max(maxRelevance.get(r.tier) ?? 0, r.rawRelevance));

      const scored = rawScored.map(({ item, rawRelevance, recency, tier, prefix }) => {
        const max = maxRelevance.get(tier) ?? 0;
        const denom = max > 0 ? max : 1;
        return { item, tier, prefix, score: (rawRelevance / denom) * relevanceWeight + recency * recencyWeight };
      });

      // Full-term matches always rank above partial ones, and within the full
      // tier exact matches above prefix-only ones (the order FTS returned them
      // in); scoring orders within each group.
      const rankedScored = scored
        .sort((a, b) => a.tier - b.tier || Number(a.prefix) - Number(b.prefix) || b.score - a.score)
        .slice(0, limit);
      const ranked = rankedScored.map(({ item }) => item);

      if (meta) {
        meta.tiers = new Map(rankedScored.map(({ item, tier }) => [item.id, tier]));
        // Strongest lexical match among the returned hits of the best tier:
        // the min (most negative) raw BM25. If even the best hit is weak,
        // coverage is weak. A partial top-up row's score says nothing about
        // how well the full matches cover the query, so it only counts when
        // the page holds no full match.
        const topTier = rankedScored.length > 0 ? rankedScored[0].tier : undefined;
        let best: number | null = null;
        for (const { item, tier } of rankedScored) {
          if (tier !== topTier) continue;
          const raw = bm25ById.get(item.id);
          if (raw === undefined) continue;
          if (best === null || raw < best) best = raw;
        }
        meta.topBm25 = best;
      }

      return ranked;
    } finally {
      fts.close();
    }
  }
}
