/**
 * `memspec import --format okf <dir>`: rebuild memspec records from an OKF
 * bundle written by `memspec export --format okf`.
 *
 * Why a separate `import` command rather than a flag on an existing one: the
 * CLI's only importer is `import-openclaw` (a one-off legacy migration with
 * its own flags); this one is the inverse of `export` and takes the same
 * `--format` axis, so a verb pair `export`/`import` is the pattern that fits.
 *
 * The target store is resolved like every other write (`remember`,
 * `observe`): `CompositeStore.resolveWritableWithDefaults`, so a pointer file
 * or a `stores:` block is honoured, read-only layers refuse, and several
 * writable layers need `--store <name>`.
 *
 * Every record goes through `decodeOkfDocument` (OKF field checks) and
 * `assertValidFrontmatter`, so a bundle edited into an invalid shape is
 * rejected per file instead of landing in the store. Records are placed where
 * the store's own commands put them: questions under `memory/questions/` (as
 * `questions.ts` writes them), superseded and retired records under
 * `archive/`, the rest through `MemspecStore.writeItem` (tier directory by
 * source_kind, gitignore upkeep). Files that are not memspec exports (no
 * `x-memspec` extension, e.g. a foreign OKF bundle) are skipped with a reason,
 * never guessed at: an OKF concept has no id, source or check_by to rebuild
 * from. Records whose id already exists in the read view, or in any file of
 * the target store (including one that fails to load), are skipped, never
 * overwritten; the write itself is exclusive-create, so a concurrent import
 * of the same record cannot replace it either.
 *
 * File-backed evidence blobs are copied from the bundle's `evidence/` tree
 * through `attachEvidence` (same containment and secret checks as `remember
 * --evidence`) once the sha256 matches the entry; a record whose blob is
 * missing or altered is an error, not imported.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { CompositeStore } from '../lib/composite-store.js';
import { attachEvidence, EVIDENCE_DIR } from '../lib/evidence.js';
import { serializeMemoryFile } from '../lib/frontmatter.js';
import { QUESTIONS_SUBDIR } from '../lib/questions.js';
import { parseFrontMatter } from '../lib/safe-matter.js';
import { assertValidFrontmatter } from '../lib/schema.js';
import type { MemspecStore } from '../lib/store.js';
import type { MemoryFrontmatter } from '../lib/types.js';
import { decodeOkfDocument, fileBackedEvidence, OKF_RESERVED_FILES, OkfNotMemspecError, readEvidenceBlob } from './okf.js';

export interface ImportOkfOptions {
  cwd?: string;
  /** Bundle directory (searched recursively for concept `.md` files). */
  dir: string;
  /** Target layer when the cwd has several writable layers (as `remember --store`). */
  store?: string;
}

export interface ImportOkfResult {
  imported: string[];
  /** Existing ids and non-memspec files, with the reason. */
  skipped: Array<{ file: string; reason: string }>;
  /** Files that failed to parse or validate. */
  errors: Array<{ file: string; reason: string }>;
}

function conceptFiles(dir: string, root = true): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // The bundle-root evidence/ tree holds blobs, not concepts.
      if (!(root && entry.name === EVIDENCE_DIR)) out.push(...conceptFiles(full, false));
    } else if (entry.isFile() && entry.name.endsWith('.md') && !(root && (OKF_RESERVED_FILES as readonly string[]).includes(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

/** Write a record where the store's own commands keep it; exclusive-create on every path. */
function placeRecord(store: MemspecStore, record: MemoryFrontmatter & { title: string; body: string }): void {
  let dir: string | undefined;
  if (record.kind === 'question') dir = join(store.root, QUESTIONS_SUBDIR);
  else if (record.state !== 'active') dir = join(store.root, 'archive');
  if (!dir) {
    store.writeItem(record, { exclusive: true });
    return;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${record.id}.md`), serializeMemoryFile(record), { flag: 'wx' });
}

export function runImportOkf(options: ImportOkfOptions): ImportOkfResult {
  const dir = resolve(options.dir);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`${dir} is not a directory`);

  const resolved = CompositeStore.resolveWritableWithDefaults(options.cwd, options.store);
  const store = resolved.layer.store;
  store.init();
  const existing = new Set(resolved.composite.loadAll().map((i) => i.id));
  for (const file of store.recordFiles()) existing.add(basename(file, '.md'));

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
      // Check every blob before copying any. A blob copied for a record whose
      // write then fails is content-addressed and inert.
      const blobs = fileBackedEvidence(fm);
      for (const entry of blobs) readEvidenceBlob(dir, entry);
      for (const entry of blobs) {
        const copied = attachEvidence(store.root, join(dir, entry.path!));
        if (copied.path !== entry.path) throw new Error(`evidence blob ${entry.path} landed at ${copied.path}`);
      }
      placeRecord(store, { ...fm, title: decoded.title, body: decoded.body });
      existing.add(id);
      result.imported.push(id);
    } catch (err) {
      const reason = (err as NodeJS.ErrnoException).code === 'EEXIST'
        ? 'a record file with this id appeared during the import; not overwritten'
        : err instanceof Error ? err.message : String(err);
      if (err instanceof OkfNotMemspecError) result.skipped.push({ file, reason });
      else result.errors.push({ file, reason });
    }
  }
  return result;
}
