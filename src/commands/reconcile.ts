import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkAnchors, getCodeAnchors, projectRootForStore } from '../lib/anchors.js';
import { MemspecStore } from '../lib/store.js';

export interface ReconcileOptions {
  cwd?: string;
  since?: string;
  json?: boolean;
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

export interface ReconcileResult {
  reconciled_at: string;
  since_ref: string | null;
  head: string | null;
  anchored_memories: number;
  candidates: ReconcileCandidate[];
  message: string;
}

const CHECKPOINT_FILE = '.reconcile.json';

function git(projectRoot: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function refIsValid(projectRoot: string, ref: string): boolean {
  return git(projectRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) !== null;
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
  if (refIsValid(projectRoot, 'HEAD~10')) return 'HEAD~10';
  // Young repo: fall back to the root commit so the whole history is in range.
  const root = git(projectRoot, ['rev-list', '--max-parents=0', 'HEAD']);
  return root ? root.split('\n')[0] : null;
}

/** Map of old-path → new-path for files renamed since sinceRef (committed) or uncommitted. */
function renameMap(projectRoot: string, sinceRef: string | null): Map<string, string> {
  const renames = new Map<string, string>();
  const diffs: string[][] = [['diff', '--name-status', '-M', 'HEAD']];
  if (sinceRef) diffs.push(['diff', '--name-status', '-M', sinceRef, 'HEAD']);

  for (const args of diffs) {
    const output = git(projectRoot, args);
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
  const inGitRepo = git(projectRoot, ['rev-parse', '--is-inside-work-tree']) === 'true';
  const sinceRef = inGitRepo ? resolveSinceRef(projectRoot, store.root, options.since) : null;
  const head = inGitRepo ? git(projectRoot, ['rev-parse', 'HEAD']) : null;
  const renames = inGitRepo ? renameMap(projectRoot, sinceRef) : new Map<string, string>();

  const anchored = store.loadActive().filter((item) => getCodeAnchors(item).length > 0);
  const candidates: ReconcileCandidate[] = [];

  for (const item of anchored) {
    const drifted = checkAnchors(projectRoot, getCodeAnchors(item)).filter((a) => a.status !== 'unchanged');
    if (drifted.length === 0) continue;

    candidates.push({
      memory_id: item.id,
      type: item.type ?? 'observation',
      title: item.title,
      last_verified: item.last_verified ?? null,
      changed_files: drifted.map((a) => {
        const renamedTo = a.status === 'missing' ? renames.get(a.file) : undefined;
        return renamedTo
          ? { file: a.file, status: 'renamed' as const, renamedTo }
          : { file: a.file, status: a.status as 'changed' | 'missing' };
      }),
    });
  }

  const reconciledAt = new Date().toISOString();

  // Checkpoint: next reconcile without --since picks up from this HEAD.
  if (head) {
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
    lines.push('  memspec correct <id> --reason ... --replace ...  # memory is now wrong');
    lines.push('  memspec anchor <id> <files...>               # still true; re-baseline anchors');
  }
  if (sinceRef) lines.push('', `Range: ${sinceRef.substring(0, 12)}..HEAD (checkpoint updated)`);

  return {
    reconciled_at: reconciledAt,
    since_ref: sinceRef,
    head,
    anchored_memories: anchored.length,
    candidates,
    message: lines.join('\n'),
  };
}
