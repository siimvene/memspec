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

    // Item metadata table for confidence/recency filtering
    this.db.exec(`
      CREATE TABLE items (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        confidence REAL NOT NULL,
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
      'INSERT OR REPLACE INTO items (id, type, confidence, created) VALUES (?, ?, ?, ?)',
    );
    const insertFts = this.db.prepare(
      'INSERT INTO items_fts (id, title, tags, body) VALUES (?, ?, ?, ?)',
    );

    const batch = this.db.transaction((items: MemoryItem[]) => {
      for (const item of items) {
        insertItem.run(item.id, item.type, item.confidence, item.created);
        insertFts.run(item.id, item.title, item.tags.join(' '), item.body);
      }
    });

    batch(items);
  }

  /**
   * Search using FTS5 with BM25 ranking.
   * Falls back to prefix matching if exact match yields no results.
   */
  search(query: string, options: FtsSearchOptions = {}): FtsScoredResult[] {
    const {
      limit = 10,
      types,
      minConfidence = 0,
    } = options;

    // Build the FTS5 query: each term gets quoted, joined with OR for broad recall
    const terms = query.trim().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];

    // Try exact terms first, then prefix
    let results = this.runFtsQuery(terms, false, types, minConfidence, limit);
    if (results.length === 0) {
      results = this.runFtsQuery(terms, true, types, minConfidence, limit);
    }

    return results;
  }

  private runFtsQuery(
    terms: string[],
    prefix: boolean,
    types: string[] | undefined,
    minConfidence: number,
    limit: number,
  ): FtsScoredResult[] {
    // Build FTS5 match expression
    // For multi-term: use AND to require all terms
    const ftsTerms = terms.map((t) => {
      // Escape double quotes in terms
      const base = prefix ? toPrefixStem(t) : t;
      const escaped = base.replace(/"/g, '""');
      return prefix ? `"${escaped}"*` : `"${escaped}"`;
    });
    const matchExpr = ftsTerms.join(' AND ');

    // BM25 weights: title(10), tags(5), body(1)
    let sql = `
      SELECT items_fts.id, bm25(items_fts, 10.0, 5.0, 1.0) as rank
      FROM items_fts
      JOIN items ON items.id = items_fts.id
      WHERE items_fts MATCH ?
        AND items.confidence >= ?
    `;
    const params: unknown[] = [matchExpr, minConfidence];

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
