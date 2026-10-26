import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { blobSha, checkAnchors, getCodeAnchors, projectRootForStore, resolveAnchorRepo } from '../lib/anchors.js';
import { loadConfig } from '../lib/config.js';
import { effectiveSourceKind, type WriteChannel } from '../lib/source.js';
import { MemspecStore } from '../lib/store.js';
import type { CodeAnchor, MemoryItem } from '../lib/types.js';

export interface ReconcileOptions {
  cwd?: string;
  since?: string;
  json?: boolean;
  /** v0.10: re-point anchors whose file moved with identical content (dry-run unless `apply`). */
  repairRenames?: boolean;
  /** v0.10: with `repairRenames`, actually write the re-points instead of listing them. */
  apply?: boolean;
  /**
   * Which surface invoked this. On `mcp`, `apply` never rewrites an
   * operator-sourced record's anchors (even a byte-identical move): the
   * repair is listed with `applied: false` and the CLI command to run.
   */
  channel?: WriteChannel;
}

export interface ReconciledFile {
  file: string;
  status: 'changed' | 'missing' | 'renamed';
  renamedTo?: string;
}

export interface ReconcileCandidate {
  memory_id: string;
  type: string;
  title: string;
  last_verified: string | null;
  changed_files: ReconciledFile[];
}

export interface RenameRepair {
  memory_id: string;
  from: string;
  to: string;
  applied: boolean;
  /** Why an `apply` left this repair unwritten (an operator record over MCP). */
  skipped?: string;
}

export interface ReconcileResult {
  reconciled_at: string;
  since_ref: string | null;
  head: string | null;
  anchored_memories: number;
  candidates: ReconcileCandidate[];
  repairs: RenameRepair[];
  message: string;
}

const CHECKPOINT_FILE = '.reconcile.json';

function git(repoRoot: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function refIsValid(repoRoot: string, ref: string): boolean {
  return git(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) !== null;
}

function readCheckpoint(storeRoot: string): { head?: string } | null {
  const path = join(storeRoot, CHECKPOINT_FILE);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as { head?: string };
  } catch {
    return null;
  }
}

function resolveSinceRef(projectRoot: string, storeRoot: string, requested?: string): string | null {
  if (requested) {
    if (!refIsValid(projectRoot, requested)) {
      throw new Error(`Not a valid git ref: ${requested}`);
    }
    return requested;
  }
  const checkpoint = readCheckpoint(storeRoot);
  if (checkpoint?.head && refIsValid(projectRoot, checkpoint.head)) return checkpoint.head;
  return fallbackSince(projectRoot);
}

/** Young-repo-safe default range for a repo we have no checkpoint/`--since` for. */
function fallbackSince(repoRoot: string): string | null {
  if (refIsValid(repoRoot, 'HEAD~10')) return 'HEAD~10';
  const root = git(repoRoot, ['rev-list', '--max-parents=0', 'HEAD']);
  return root ? root.split('\n')[0] : null;
}

/** Map of old-path → new-path for files renamed since sinceRef (committed) or uncommitted, keyed repo-relative. */
function repoRenameMap(repoRoot: string, sinceRef: string | null): Map<string, string> {
  const renames = new Map<string, string>();
  const diffs: string[][] = [['diff', '--name-status', '-M', 'HEAD']];
  if (sinceRef) diffs.push(['diff', '--name-status', '-M', sinceRef, 'HEAD']);

  for (const args of diffs) {
    const output = git(repoRoot, args);
    if (!output) continue;
    for (const line of output.split('\n')) {
      const parts = line.split('\t');
      if (parts.length === 3 && parts[0].startsWith('R')) {
        renames.set(parts[1], parts[2]);
      }
    }
  }
  return renames;
}

export function runReconcile(options: ReconcileOptions): ReconcileResult {
  const store = new MemspecStore(options.cwd);
  if (!store.exists) throw new Error(`No memspec store found at ${store.root}`);

  const projectRoot = projectRootForStore(store.root);
  const config = loadConfig(store.root);
  const repoSearchPaths = config.anchors?.repo_search_paths ?? [];

  // The checkpoint + `--since` semantics belong to the project's own repo (if
  // it has one). Anchors that live in OTHER repos — the normal case for a
  // home-rooted store, where projectRoot is the home dir and each anchor points
  // into `~/git/<repo>/...` — get rename detection inside their own repo, with
  // a per-repo default range.
  const projectGitRoot = git(projectRoot, ['rev-parse', '--is-inside-work-tree']) === 'true' ? projectRoot : null;
  const sinceRef = projectGitRoot ? resolveSinceRef(projectGitRoot, store.root, options.since) : null;
  const head = projectGitRoot ? git(projectGitRoot, ['rev-parse', 'HEAD']) : null;

  const renameCache = new Map<string, Map<string, string>>();
  const renamesFor = (repoRoot: string): Map<string, string> => {
    let m = renameCache.get(repoRoot);
    if (m) return m;
    const since = projectGitRoot && repoRoot === projectGitRoot ? sinceRef : fallbackSince(repoRoot);
    m = repoRenameMap(repoRoot, since);
    renameCache.set(repoRoot, m);
    return m;
  };

  const anchored = store.loadActive().filter((item) => getCodeAnchors(item).length > 0);
  const candidates: ReconcileCandidate[] = [];
  const repairs: RenameRepair[] = [];
  // Grouped re-points to apply per item (an item can carry several anchors).
  // Anchor identity is (repo, file), not file alone (S7): two anchors can share
  // a filename in different repos, and only the moved one may be rewritten.
  const repointsByItem = new Map<string, { item: MemoryItem; moves: Array<{ fromFile: string; fromRepo?: string; to: string }> }>();

  for (const item of anchored) {
    const drifted = checkAnchors(projectRoot, getCodeAnchors(item), { repoSearchPaths })
      .filter((a) => a.status !== 'unchanged');
    if (drifted.length === 0) continue;

    const changedFiles: ReconciledFile[] = [];
    for (const a of drifted) {
      const anchor: CodeAnchor = { file: a.file, sha: a.sha, ...(a.repo ? { repo: a.repo } : {}) };
      const resolved = a.status === 'missing' ? resolveAnchorRepo(projectRoot, anchor, { repoSearchPaths }) : null;
      const newRel = resolved ? renamesFor(resolved.repoRoot).get(resolved.relPath) : undefined;

      if (resolved && newRel) {
        const newAbs = resolve(resolved.repoRoot, newRel);
        const displayNew = anchor.repo ? newRel : relative(projectRoot, newAbs).split(sep).join('/');
        changedFiles.push({ file: a.file, status: 'renamed', renamedTo: displayNew });
        // Re-point only when the moved file's content is byte-identical to the
        // anchor's recorded blob. A content change is the signal to re-verify
        // the claim, not something to silently paper over — leave it drifted.
        // Only top-level anchors are rewritable; a legacy ext.code_anchors entry
        // is left alone rather than reported as a repair we won't actually make.
        // Match on the exact (repo, file) entry, not file alone (S7).
        const isTopLevel = (item.anchors ?? []).some((x) => x.file === a.file && x.repo === a.repo);
        if (options.repairRenames && isTopLevel && blobSha(newAbs) === a.sha) {
          // Over MCP an operator record is read-only: list the re-point, never write it.
          const operatorOverMcp = options.channel === 'mcp' && effectiveSourceKind(item) === 'operator';
          repairs.push({
            memory_id: item.id,
            from: a.file,
            to: displayNew,
            applied: options.apply === true && !operatorOverMcp,
            ...(options.apply && operatorOverMcp
              ? { skipped: `operator-sourced; re-pointing operator memory is not available over MCP (a human runs \`memspec reconcile --repair-renames --apply\` from a terminal)` }
              : {}),
          });
          if (options.apply && !operatorOverMcp) {
            const bucket = repointsByItem.get(item.id) ?? { item, moves: [] };
            bucket.moves.push({ fromFile: a.file, fromRepo: a.repo, to: displayNew });
            repointsByItem.set(item.id, bucket);
          }
        }
      } else {
        changedFiles.push({ file: a.file, status: a.status as 'changed' | 'missing' });
      }
    }

    candidates.push({
      memory_id: item.id,
      type: item.type ?? 'observation',
      title: item.title,
      last_verified: item.last_verified ?? null,
      changed_files: changedFiles,
    });
  }

  // Apply re-points: rewrite each item's top-level anchors to the new paths,
  // preserving the recorded sha (content is identical by construction).
  if (options.repairRenames && options.apply) {
    for (const { item, moves } of repointsByItem.values()) {
      const anchors = (item.anchors ?? []).map((anchor) => {
        const move = moves.find((m) => m.fromFile === anchor.file && m.fromRepo === anchor.repo);
        return move ? { ...anchor, file: move.to } : anchor;
      });
      store.updateItem({ ...item, anchors });
    }
  }

  const reconciledAt = new Date().toISOString();

  // Checkpoint: next reconcile without --since picks up from this HEAD. Only
  // meaningful when the project itself is a git repo. A repair DRY-RUN must NOT
  // advance it (S6): otherwise the instructed `--apply` rerun resolves
  // since=HEAD, diffs HEAD..HEAD, and finds nothing to repair. Only a real
  // pass (plain reconcile, or repair --apply) moves the checkpoint.
  const advanceCheckpoint = !(options.repairRenames && !options.apply);
  if (head && projectGitRoot && advanceCheckpoint) {
    writeFileSync(
      join(store.root, CHECKPOINT_FILE),
      JSON.stringify({ head, reconciled_at: reconciledAt }, null, 2) + '\n',
    );
  }

  const lines: string[] = [];
  if (candidates.length === 0) {
    lines.push(`Reconcile clean: ${anchored.length} anchored memory(ies) match current code.`);
  } else {
    lines.push(`${candidates.length} memory(ies) need reconciliation (of ${anchored.length} anchored):`, '');
    for (const c of candidates) {
      lines.push(`[${c.type}] ${c.title}`);
      lines.push(`  ${c.memory_id} (last verified: ${c.last_verified?.substring(0, 10) ?? 'never'})`);
      for (const f of c.changed_files) {
        lines.push(f.status === 'renamed'
          ? `  renamed: ${f.file} → ${f.renamedTo}`
          : `  ${f.status}: ${f.file}`);
      }
      lines.push('');
    }
    lines.push('For each candidate, review the changed files and run one of:');
    lines.push('  memspec verify <id>                          # confirms — fails while anchors drift');
    lines.push('  memspec supersede <id> --reason ... --body ...  # memory is now wrong');
    lines.push('  memspec anchor <id> <files...>               # still true; re-baseline anchors');
  }
  if (options.repairRenames) {
    if (repairs.length === 0) {
      lines.push('', 'Rename repair: no identical-content moves to re-point.');
    } else {
      lines.push('', `Rename repair (${options.apply ? 'APPLIED' : 'DRY-RUN'}) — ${repairs.length} anchor(s) re-pointed:`);
      for (const r of repairs) lines.push(`  ${r.memory_id}: ${r.from} → ${r.to}${r.skipped ? ` (NOT APPLIED: ${r.skipped})` : ''}`);
      if (!options.apply) lines.push('  Re-run with --repair-renames --apply to write these re-points.');
    }
  }
  if (sinceRef) lines.push('', `Range: ${sinceRef.substring(0, 12)}..HEAD (checkpoint updated)`);

  return {
    reconciled_at: reconciledAt,
    since_ref: sinceRef,
    head,
    anchored_memories: anchored.length,
    candidates,
    repairs,
    message: lines.join('\n'),
  };
}
