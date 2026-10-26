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
 *
 * Trust is re-derived by default. A bundle is just files: anyone can write
 * `source: siim`, `pinned: true` (injected into every session's boot context)
 * or `verified_with: anchor` into one, so the bundle's trust fields are not
 * believed. Every imported record lands as `source: okf-import`,
 * `source_kind: import` (never operator tier), unpinned, with `verified_with`
 * recomputed the way `remember` computes it from what the import can check
 * itself: `anchor` when every anchor re-hashes to its recorded sha in the local
 * checkout, else `evidence` when it carries a file-backed blob (sha256 checked
 * above), else `assertion`; `last_verified` is clamped to the import time. The
 * bundle's original values are kept under `ext.okf_import`. `trusted: true`
 * (CLI `--trusted`, for restoring one's own backup) keeps them verbatim.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { checkAnchors, projectRootForStore } from '../lib/anchors.js';
import { CompositeStore } from '../lib/composite-store.js';
import { loadConfig } from '../lib/config.js';
import { attachEvidence, EVIDENCE_DIR } from '../lib/evidence.js';
import { serializeMemoryFile } from '../lib/frontmatter.js';
import { QUESTIONS_SUBDIR } from '../lib/questions.js';
import { parseFrontMatter } from '../lib/safe-matter.js';
import { assertValidFrontmatter } from '../lib/schema.js';
import type { MemspecStore } from '../lib/store.js';
import { effectiveSourceKind } from '../lib/source.js';
import type { MemoryFrontmatter, VerifiedWith } from '../lib/types.js';
import { decodeOkfDocument, fileBackedEvidence, OKF_RESERVED_FILES, OkfNotMemspecError, readEvidenceBlob } from './okf.js';

export interface ImportOkfOptions {
  cwd?: string;
  /** Bundle directory (searched recursively for concept `.md` files). */
  dir: string;
  /** Target layer when the cwd has several writable layers (as `remember --store`). */
  store?: string;
  /**
   * Keep the bundle's trust fields (source/source_kind, pinned, verified_with,
   * last_verified) verbatim. Only for a bundle the operator wrote themselves.
   */
  trusted?: boolean;
  /** Import time (tests); defaults to now. */
  now?: Date;
}

/** What the default (untrusted) import changed on one record's trust fields. */
export type TrustChange = 'tier' | 'pinned' | 'witness' | 'last_verified';

export const OKF_IMPORT_SOURCE = 'okf-import';

export interface ImportOkfResult {
  imported: string[];
  /** Existing ids and non-memspec files, with the reason. */
  skipped: Array<{ file: string; reason: string }>;
  /** Files that failed to parse or validate. */
  errors: Array<{ file: string; reason: string }>;
  /** Imported records whose trust fields were downgraded (default mode only). */
  downgraded: Array<{ id: string; changes: TrustChange[] }>;
}

const WITNESS_RANK: Record<VerifiedWith, number> = { anchor: 4, probe: 3, operator: 2, evidence: 1, assertion: 0 };

interface TrustContext {
  projectRoot: string;
  repoSearchPaths: string[];
  now: Date;
}

/**
 * Replace a bundle record's trust fields with what this import can stand
 * behind (see the module comment). Returns the record and the downgrades.
 */
function rederiveTrust(fm: MemoryFrontmatter, ctx: TrustContext): { record: MemoryFrontmatter; changes: TrustChange[] } {
  const changes: TrustChange[] = [];
  const nowIso = ctx.now.toISOString();
  const record: MemoryFrontmatter = { ...fm, source: OKF_IMPORT_SOURCE, source_kind: 'import' };
  if (effectiveSourceKind(fm) === 'operator') changes.push('tier');

  delete record.pinned;
  if (fm.pinned) changes.push('pinned');

  // Same order as `remember`: anchors > (operator: never, the tier is import) > file evidence > assertion.
  // A probe is not re-run here (it executes a shell command), so it witnesses nothing on import.
  const anchors = fm.anchors ?? [];
  const anchored = anchors.length > 0
    && checkAnchors(ctx.projectRoot, anchors, { repoSearchPaths: ctx.repoSearchPaths }).every((a) => a.status === 'unchanged');
  const witness: VerifiedWith = anchored ? 'anchor' : fileBackedEvidence(fm).length > 0 ? 'evidence' : 'assertion';
  record.verified_with = witness;
  if (fm.verified_with && WITNESS_RANK[fm.verified_with] > WITNESS_RANK[witness]) changes.push('witness');

  // last_verified defaults to created on read, so a future `created` would
  // sort first just the same: the clamp covers the effective value.
  const claimed = fm.last_verified ?? fm.created;
  if (Date.parse(claimed) > ctx.now.getTime()) {
    record.last_verified = nowIso;
    changes.push('last_verified');
  }

  const original: Record<string, unknown> = { imported_at: nowIso, source: fm.source };
  if (fm.source_kind !== undefined) original.source_kind = fm.source_kind;
  if (fm.pinned !== undefined) original.pinned = fm.pinned;
  if (fm.verified_with !== undefined) original.verified_with = fm.verified_with;
  if (fm.last_verified !== undefined) original.last_verified = fm.last_verified;
  record.ext = { ...(fm.ext ?? {}), okf_import: original };
  return { record, changes };
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

  const trust: TrustContext = {
    projectRoot: projectRootForStore(store.root),
    repoSearchPaths: loadConfig(store.root).anchors?.repo_search_paths ?? [],
    now: options.now ?? new Date(),
  };

  const result: ImportOkfResult = { imported: [], skipped: [], errors: [], downgraded: [] };
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
      let fm = assertValidFrontmatter(decoded.frontmatter) as MemoryFrontmatter;
      // Check every blob before copying any. A blob copied for a record whose
      // write then fails is content-addressed and inert.
      const blobs = fileBackedEvidence(fm);
      for (const entry of blobs) readEvidenceBlob(dir, entry);
      let changes: TrustChange[] = [];
      if (!options.trusted) {
        ({ record: fm, changes } = rederiveTrust(fm, trust));
        fm = assertValidFrontmatter(fm) as MemoryFrontmatter;
      }
      for (const entry of blobs) {
        const copied = attachEvidence(store.root, join(dir, entry.path!));
        if (copied.path !== entry.path) throw new Error(`evidence blob ${entry.path} landed at ${copied.path}`);
      }
      placeRecord(store, { ...fm, title: decoded.title, body: decoded.body });
      existing.add(id);
      result.imported.push(id);
      if (changes.length > 0) result.downgraded.push({ id, changes });
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
