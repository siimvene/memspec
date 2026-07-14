import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { defaultConfigYaml, type ConfigGenerationOptions } from './config.js';
import { FtsIndex } from './fts.js';
import { parseMemoryFile, serializeMemoryFile } from './frontmatter.js';
import { validateFrontmatter } from './schema.js';
import { effectiveSourceKind, storageTierForSourceKind } from './source.js';
import type { MemoryFrontmatter, MemoryItem, MemoryType } from './types.js';
import matter from 'gray-matter';

/**
 * v0.3: items past check_by are stale at read time, even when the on-disk
 * frontmatter hasn't been touched yet. The flag is computed lazily so callers
 * (search, sweep, status) see the current state without a separate decay run.
 * Files are never mutated here — physical retirement is still `memspec sweep`.
 */
function withLazyStale(item: MemoryItem): MemoryItem {
  if (item.stale) return item;
  if (item.check_by === 'never' || !item.check_by) return item;
  if (item.kind === 'observation') return item;
  const expiry = Date.parse(item.check_by);
  if (Number.isNaN(expiry)) return item;
  if (Date.now() <= expiry) return item;
  return { ...item, stale: true };
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
  minConfidence?: number;
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

export class MemspecStore {
  readonly root: string;
  readonly warnings: LoadWarning[] = [];

  constructor(root?: string) {
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
    this.root = basename(resolved) === '.memspec' ? resolved : join(resolved, '.memspec');
  }

  private findRoot(): string {
    let dir = process.cwd();
    while (dir !== '/') {
      const candidate = join(dir, '.memspec');
      if (existsSync(candidate)) return candidate;
      dir = resolve(dir, '..');
    }
    return join(process.cwd(), '.memspec');
  }

  get exists(): boolean {
    return existsSync(this.root);
  }

  get configPath(): string {
    return join(this.root, 'config.yaml');
  }

  init(configOptions?: ConfigGenerationOptions): void {
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

    const gitignorePath = join(this.root, '.gitignore');
    if (!existsSync(gitignorePath)) {
      writeFileSync(
        gitignorePath,
        '# Derived search index — rebuildable from files\n*.db\n*.db-journal\n*.db-wal\n.fts.db\n.fts.db-journal\n.fts.db-wal\n# Per-clone reconcile checkpoint\n.reconcile.json\n# Local retrieval log — boot usage_boost input\nusage.jsonl\n',
      );
    }

    if (!existsSync(this.configPath)) {
      writeFileSync(this.configPath, defaultConfigYaml(configOptions));
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

  writeItem(item: MemoryFrontmatter & { title: string; body: string }): string {
    const filePath = this.pathForItem(item);
    const dir = resolve(filePath, '..');
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, serializeMemoryFile(item));
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

  loadAll(): MemoryItem[] {
    const files = [
      ...walkMarkdownFiles(join(this.root, 'memory')),
      ...walkMarkdownFiles(join(this.root, 'observations')),
      ...walkMarkdownFiles(join(this.root, 'archive')),
    ];

    this.warnings.length = 0;
    // Phase 4: collision defence. Same id appearing in both standard and operator
    // paths shouldn't happen, but if it does the operator path wins (more
    // authoritative). Stderr warning so callers notice the drift; no throw.
    const operatorMemoryRoot = join(this.root, 'memory', 'operator');
    const byId = new Map<string, MemoryItem>();

    for (const file of files) {
      try {
        const raw = readFileSync(file, 'utf8');
        const parsed = matter(raw);
        const data = parsed.data as Record<string, unknown>;

        // Coerce dates before validation (both legacy decay_after and v0.3 check_by)
        for (const key of ['created', 'decay_after', 'check_by', 'last_verified', 'expires']) {
          if (data[key] instanceof Date) {
            data[key] = (data[key] as Date).toISOString();
          }
        }

        const result = validateFrontmatter(data);
        if (!result.success) {
          this.warnings.push({ file, reason: `Invalid frontmatter: ${result.errors.join('; ')}` });
          continue;
        }

        const item = parseMemoryFile(raw, file);
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

    return Array.from(byId.values());
  }

  loadActive(): MemoryItem[] {
    return this.loadAll()
      .filter((item) => item.state === 'active')
      .map((item) => withLazyStale(item));
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

  findById(id: string): MemoryItem | null {
    return this.loadAll().find((item) => item.id === id) ?? null;
  }

  moveToArchive(item: MemoryItem, state: MemoryItem['state'] = 'retired'): void {
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
    writeFileSync(item.filePath, serializeMemoryFile(item));
  }

  // Note: hybrid/embedding search is a planned future feature. Currently FTS5-only.
  search(query: string, options: StoreSearchOptions = {}): MemoryItem[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];

    const {
      limit = 10,
      types,
      minConfidence = 0,
      ranking,
    } = options;

    const activeItems = this.loadActive();

    // mtime-cached on-disk FTS index. Rebuild only when a source file's mtime
    // is newer than the cache — at 200 items the win is invisible, at 5k it's
    // 250ms → 5ms. Canonical truth still lives in markdown files.
    const cachePath = join(this.root, '.fts.db');
    const fts = FtsIndex.openOrBuild(cachePath, this.activeSourceFiles(), activeItems);
    try {
      const matches = fts.search(query, { limit: limit * 2, types, minConfidence });

      if (matches.length === 0) return [];

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
      const rawScored = matches.map(({ id, bm25Score }) => {
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

        return { item, rawRelevance, recency };
      }).filter((entry): entry is { item: MemoryItem; rawRelevance: number; recency: number } => entry !== null);

      // Per-set relevance normalization → [0, 1]. recency is already in [0, 1].
      const maxRelevance = rawScored.reduce((m, r) => Math.max(m, r.rawRelevance), 0);
      const denom = maxRelevance > 0 ? maxRelevance : 1;

      const scored = rawScored.map(({ item, rawRelevance, recency }) => ({
        item,
        score: (rawRelevance / denom) * relevanceWeight + recency * recencyWeight,
      }));

      return scored
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(({ item }) => item);
    } finally {
      fts.close();
    }
  }
}
