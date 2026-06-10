import { resolve } from 'node:path';
import { blobSha, getCodeAnchors, normalizeAnchorPath, projectRootForStore } from '../lib/anchors.js';
import { MemspecStore } from '../lib/store.js';
import type { CodeAnchor } from '../lib/types.js';

export interface AnchorOptions {
  cwd?: string;
  replace?: boolean;
  source?: string;
}

export interface AnchorResult {
  id: string;
  anchors: CodeAnchor[];
  warnings: string[];
  message: string;
}

export function runAnchor(id: string, files: string[], options: AnchorOptions): AnchorResult {
  const store = new MemspecStore(options.cwd);
  const item = store.findById(id);

  if (!item) throw new Error(`Memory not found: ${id}`);
  if (item.state !== 'active') {
    throw new Error(`Cannot anchor memory in state: ${item.state} (only active memories can be anchored)`);
  }
  if (files.length === 0) throw new Error('No files given to anchor');

  const projectRoot = projectRootForStore(store.root);
  const warnings: string[] = [];
  const fresh: CodeAnchor[] = [];

  for (const file of files) {
    const rel = normalizeAnchorPath(projectRoot, file);
    const sha = blobSha(resolve(projectRoot, rel));
    if (sha === null) {
      warnings.push(`Skipped ${rel}: file not found under ${projectRoot}`);
      continue;
    }
    if (!fresh.some((a) => a.file === rel)) {
      fresh.push({ file: rel, sha });
    }
  }

  if (fresh.length === 0) {
    throw new Error(`None of the given files exist under ${projectRoot}:\n${warnings.join('\n')}`);
  }

  // Merge: fresh anchors win over existing entries for the same file.
  const existing = options.replace ? [] : getCodeAnchors(item);
  const anchors = [
    ...existing.filter((a) => !fresh.some((f) => f.file === a.file)),
    ...fresh,
  ];

  const now = new Date().toISOString();
  const ext = { ...(item.ext ?? {}) } as Record<string, unknown>;
  ext.code_anchors = anchors;

  // Anchoring asserts the memory is true against current file state.
  store.updateItem({
    ...item,
    last_verified: now,
    ext,
  });

  const lines = [`Anchored ${id} to ${anchors.length} file(s):`];
  for (const a of anchors) lines.push(`  ${a.file} @ ${a.sha.substring(0, 12)}`);
  lines.push(...warnings.map((w) => `⚠ ${w}`));

  return { id, anchors, warnings, message: lines.join('\n') };
}
