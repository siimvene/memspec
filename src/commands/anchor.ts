import { getCodeAnchors, projectRootForStore, resolveAnchorForWrite } from '../lib/anchors.js';
import { loadConfig } from '../lib/config.js';
import { CompositeStore } from '../lib/composite-store.js';
import { MemspecStore } from '../lib/store.js';
import type { CodeAnchor } from '../lib/types.js';

export interface AnchorOptions {
  cwd?: string;
  replace?: boolean;
  source?: string;
  /** Checkout directory a repo-relative path belongs to when it lives outside the store's project root. */
  anchorRoot?: string;
}

export interface AnchorResult {
  id: string;
  anchors: CodeAnchor[];
  warnings: string[];
  message: string;
}

export function runAnchor(id: string, files: string[], options: AnchorOptions): AnchorResult {
  // Refuse anchoring a record that lives in a read-only store layer (C2),
  // naming the layer. Non-layered stores resolve to their single writable
  // layer, keeping the resolved store identical to `new MemspecStore(cwd)`.
  const owner = CompositeStore.forCwd(options.cwd).assertWritableLayerForId(id);
  const store = owner ? owner.store : new MemspecStore(options.cwd);
  const item = store.findById(id);

  if (!item) throw new Error(`Memory not found: ${id}`);
  if (item.state !== 'active') {
    throw new Error(`Cannot anchor memory in state: ${item.state} (only active memories can be anchored)`);
  }
  if (files.length === 0) throw new Error('No files given to anchor');

  const projectRoot = projectRootForStore(store.root);
  const repoSearchPaths = loadConfig(store.root).anchors?.repo_search_paths;
  const warnings: string[] = [];
  const fresh: CodeAnchor[] = [];

  for (const file of files) {
    const result = resolveAnchorForWrite(projectRoot, file, { anchorRoot: options.anchorRoot, repoSearchPaths });
    if ('error' in result) {
      warnings.push(result.error);
      continue;
    }
    const { anchor } = result;
    if (!fresh.some((a) => a.file === anchor.file && a.repo === anchor.repo)) {
      fresh.push(anchor);
    }
  }

  if (fresh.length === 0) {
    throw new Error(`None of the given files could be resolved to an anchor:\n${warnings.join('\n')}`);
  }

  // Merge: fresh anchors win over existing entries for the same (repo, file).
  const existing = options.replace ? [] : getCodeAnchors(item);
  const anchors = [
    ...existing.filter((a) => !fresh.some((f) => f.file === a.file && f.repo === a.repo)),
    ...fresh,
  ];

  const now = new Date().toISOString();
  // v0.3 stores anchors at the top level; ext.code_anchors is dropped on touch.
  const ext = { ...(item.ext ?? {}) } as Record<string, unknown>;
  delete ext.code_anchors;

  // Anchoring asserts the memory is true against current file state, and the
  // anchor itself is the witness.
  store.updateItem({
    ...item,
    anchors,
    last_verified: now,
    verified_with: 'anchor',
    ext,
  });

  const lines = [`Anchored ${id} to ${anchors.length} file(s):`];
  for (const a of anchors) lines.push(`  ${a.file} @ ${a.sha.substring(0, 12)}`);
  lines.push(...warnings.map((w) => `⚠ ${w}`));

  return { id, anchors, warnings, message: lines.join('\n') };
}
