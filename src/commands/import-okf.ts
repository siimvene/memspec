/**
 * `memspec import --format okf <dir>`: rebuild memspec records from an OKF
 * bundle written by `memspec export --format okf`.
 *
 * Why a separate `import` command rather than a flag on an existing one: the
 * CLI's only importer is `import-openclaw` (a one-off legacy migration with
 * its own flags); this one is the inverse of `export` and takes the same
 * `--format` axis, so a verb pair `export`/`import` is the pattern that fits.
 *
 * Every record goes through `assertValidFrontmatter` and `MemspecStore.writeItem`
 * (the normal write path: tier directory by source_kind, gitignore upkeep), so
 * a bundle edited into an invalid shape is rejected per file instead of
 * landing in the store. Files that are not memspec exports (no `x-memspec`
 * extension, e.g. a foreign OKF bundle) are skipped with a reason, never
 * guessed at: an OKF concept has no id, source or check_by to rebuild from.
 * Records whose id already exists in the store are skipped, never overwritten.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseFrontMatter } from '../lib/safe-matter.js';
import { assertValidFrontmatter } from '../lib/schema.js';
import { MemspecStore } from '../lib/store.js';
import type { MemoryFrontmatter } from '../lib/types.js';
import { decodeOkfDocument, OKF_RESERVED_FILES, OkfNotMemspecError } from './okf.js';

export interface ImportOkfOptions {
  cwd?: string;
  /** Bundle directory (searched recursively for concept `.md` files). */
  dir: string;
}

export interface ImportOkfResult {
  imported: string[];
  /** Existing ids and non-memspec files, with the reason. */
  skipped: Array<{ file: string; reason: string }>;
  /** Files that failed to parse or validate. */
  errors: Array<{ file: string; reason: string }>;
}

function conceptFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...conceptFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.md') && !(OKF_RESERVED_FILES as readonly string[]).includes(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

export function runImportOkf(options: ImportOkfOptions): ImportOkfResult {
  const dir = resolve(options.dir);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`${dir} is not a directory`);

  const store = new MemspecStore(options.cwd);
  if (!store.exists) store.init();
  const existing = new Set(store.loadAll().map((i) => i.id));

  const result: ImportOkfResult = { imported: [], skipped: [], errors: [] };
  for (const file of conceptFiles(dir)) {
    try {
      const parsed = parseFrontMatter(readFileSync(file, 'utf8'));
      const decoded = decodeOkfDocument(parsed.data, parsed.content);
      const id = String(decoded.frontmatter.id);
      if (existing.has(id)) {
        result.skipped.push({ file, reason: `${id} already exists in the store` });
        continue;
      }
      // Same validation the store applies on read; throws with the field list.
      const fm = assertValidFrontmatter(decoded.frontmatter) as MemoryFrontmatter;
      store.writeItem({ ...fm, title: decoded.title, body: decoded.body });
      existing.add(id);
      result.imported.push(id);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (err instanceof OkfNotMemspecError) result.skipped.push({ file, reason });
      else result.errors.push({ file, reason });
    }
  }
  return result;
}
