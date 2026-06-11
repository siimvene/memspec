/**
 * FTS5-backed full-text search index for memspec.
 *
 * Builds an SQLite database with FTS5 virtual table from loaded items. The
 * default is an in-memory database; passing `cachePath` persists the index
 * on disk so subsequent searches reuse it (rebuilt only when any source
 * file's mtime is newer than the cache).
 *
 * BM25 ranking, porter-stemmer tokenization. Canonical truth is still the
 * markdown files — the cache is a derived artifact.
 */

import Database from 'better-sqlite3';
import { existsSync, statSync, unlinkSync } from 'node:fs';
import type { MemoryItem } from './types.js';

export interface FtsSearchOptions {
  limit?: number;
  types?: string[];
  minConfidence?: number;
  ranking?: {
    relevance?: number;
    confidence?: number;
    recency?: number;
  };
}

export interface FtsScoredResult {
  id: string;
  bm25Score: number;
}

export class FtsIndex {
  private db: InstanceType<typeof Database>;
  /** Whether the schema needs to be created (true for in-memory or rebuilt cache). */
  readonly fresh: boolean;

  constructor(cachePath?: string) {
    if (cachePath) {
      this.db = new Database(cachePath);
      const hasSchema = this.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='items'")
        .get() !== undefined;
      this.fresh = !hasSchema;
    } else {
      this.db = new Database(':memory:');
      this.fresh = true;
    }

    if (this.fresh) {
      // Item metadata table for type/recency filtering
      this.db.exec(`
        CREATE TABLE items (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          created TEXT NOT NULL
        );
      `);

      // FTS5 virtual table with porter stemmer for stemming support
      this.db.exec(`
        CREATE VIRTUAL TABLE items_fts USING fts5(
          id UNINDEXED,
          title,
          tags,
          body,
          tokenize = 'porter unicode61'
        );
      `);
    }
  }

  /**
   * Open an on-disk FTS cache if it's still valid (cache mtime newer than every
   * source file mtime). Stale caches are unlinked and rebuilt. Returns a populated
   * FtsIndex the caller can search against directly.
   */
  static openOrBuild(cachePath: string, sourceFiles: string[], items: MemoryItem[]): FtsIndex {
    if (existsSync(cachePath) && isCacheFresh(cachePath, sourceFiles)) {
      return new FtsIndex(cachePath);
    }
    // Stale or missing — drop the old file before constructing.
    if (existsSync(cachePath)) {
      try { unlinkSync(cachePath); } catch { /* ignore */ }
    }
    const fts = new FtsIndex(cachePath);
    fts.populate(items);
    return fts;
  }

  /**
   * Populate the index from a set of memory items.
   */
  populate(items: MemoryItem[]): void {
    const insertItem = this.db.prepare(
      'INSERT OR REPLACE INTO items (id, type, created) VALUES (?, ?, ?)',
    );
    const insertFts = this.db.prepare(
      'INSERT INTO items_fts (id, title, tags, body) VALUES (?, ?, ?, ?)',
    );

    const batch = this.db.transaction((items: MemoryItem[]) => {
      for (const item of items) {
        // observations have no type; bucket them as 'observation' so type filters work uniformly
        insertItem.run(item.id, item.type ?? 'observation', item.created);
        insertFts.run(item.id, item.title, item.tags.join(' '), item.body);
      }
    });

    batch(items);
  }

  /**
   * Search using FTS5 with BM25 ranking.
   *
   * Fallback chain: exact-AND → prefix-AND → exact-OR → prefix-OR.
   * AND-first keeps precision when every term matches; the OR fallback keeps
   * multi-term natural-language queries from returning zero results just
   * because one term is absent (BM25 still ranks the best match first).
   */
  search(query: string, options: FtsSearchOptions = {}): FtsScoredResult[] {
    const {
      limit = 10,
      types,
    } = options;

    const terms = query.trim().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];

    let results = this.runFtsQuery(terms, false, 'AND', types, limit);
    if (results.length === 0) {
      results = this.runFtsQuery(terms, true, 'AND', types, limit);
    }
    if (results.length === 0 && terms.length > 1) {
      results = this.runFtsQuery(terms, false, 'OR', types, limit);
      if (results.length === 0) {
        results = this.runFtsQuery(terms, true, 'OR', types, limit);
      }
    }

    return results;
  }

  private runFtsQuery(
    terms: string[],
    prefix: boolean,
    operator: 'AND' | 'OR',
    types: string[] | undefined,
    limit: number,
  ): FtsScoredResult[] {
    const ftsTerms = terms.map((t) => {
      // Escape double quotes in terms
      const base = prefix ? toPrefixStem(t) : t;
      const escaped = base.replace(/"/g, '""');
      return prefix ? `"${escaped}"*` : `"${escaped}"`;
    });
    const matchExpr = ftsTerms.join(` ${operator} `);

    // BM25 weights: title(10), tags(5), body(1)
    let sql = `
      SELECT items_fts.id, bm25(items_fts, 10.0, 5.0, 1.0) as rank
      FROM items_fts
      JOIN items ON items.id = items_fts.id
      WHERE items_fts MATCH ?
    `;
    const params: unknown[] = [matchExpr];

    if (types && types.length > 0) {
      sql += ` AND items.type IN (${types.map(() => '?').join(',')})`;
      params.push(...types);
    }

    // bm25() returns negative values (lower = better match)
    sql += ' ORDER BY rank LIMIT ?';
    params.push(limit);

    try {
      const rows = this.db.prepare(sql).all(...params) as Array<{ id: string; rank: number }>;
      return rows.map((r) => ({ id: r.id, bm25Score: r.rank }));
    } catch {
      // If FTS5 query syntax fails, return empty
      return [];
    }
  }

  close(): void {
    this.db.close();
  }
}

/** Cache is fresh iff every source file mtime <= cache mtime. */
function isCacheFresh(cachePath: string, sourceFiles: string[]): boolean {
  try {
    const cacheMtime = statSync(cachePath).mtimeMs;
    for (const file of sourceFiles) {
      if (!existsSync(file)) continue;
      const mtime = statSync(file).mtimeMs;
      if (mtime > cacheMtime) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function toPrefixStem(term: string): string {
  const lower = term.toLowerCase();
  const stripped = lower
    .replace(/(?:ation|ition|ment|ness|ingly|edly|ingly|edly)$/u, '')
    .replace(/(?:ing|edly|edly|ed|es|s)$/u, '');

  return stripped.length >= 4 ? stripped : lower;
}
