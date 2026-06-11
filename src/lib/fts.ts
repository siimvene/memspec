/**
 * FTS5-backed full-text search index for memspec.
 *
 * Builds an in-memory SQLite database with FTS5 virtual table from loaded items.
 * Provides BM25 ranking, stemming via porter tokenizer, and word-boundary tokenization.
 * The index is ephemeral — rebuilt from canonical markdown files on each search invocation.
 */

import Database from 'better-sqlite3';
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

  constructor() {
    this.db = new Database(':memory:');

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

function toPrefixStem(term: string): string {
  const lower = term.toLowerCase();
  const stripped = lower
    .replace(/(?:ation|ition|ment|ness|ingly|edly|ingly|edly)$/u, '')
    .replace(/(?:ing|edly|edly|ed|es|s)$/u, '');

  return stripped.length >= 4 ? stripped : lower;
}
