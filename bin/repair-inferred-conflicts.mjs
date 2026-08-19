#!/usr/bin/env node
// One-shot repair for ms_01KZJXHBZT6YXY9P500JFCE4SX: the similarity
// auto-attacher stamped conflicts_with onto targets the caller had already
// classified with an explicit positive edge (refines / supports / depends_on),
// producing logically impossible edge pairs. This scans a store, finds every
// record carrying the same target in BOTH conflicts_with and a positive edge,
// and drops the inferred conflict. The positive edge was stated by the caller;
// the conflict was inferred — the positive edge wins.
//
// Dry-run by default. Pass --apply to rewrite files. Files are canonical and
// the SQLite index is disposable, so a rewrite is safe; the FTS cache rebuilds
// on next read.
//
// Usage:
//   node bin/repair-inferred-conflicts.mjs [STORE_ROOT] [--apply]
//
// STORE_ROOT defaults to $MEMSPEC_ROOT or ./.memspec. A path whose basename is
// not `.memspec` has `.memspec` appended (matching MemspecStore resolution).

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import matter from 'gray-matter';

const POSITIVE_EDGES = ['refines', 'supports', 'depends_on'];

function parseArgs(argv) {
  let apply = false;
  let root;
  for (const arg of argv) {
    if (arg === '--apply') apply = true;
    else if (arg === '--help' || arg === '-h') { root = '--help'; }
    else if (!arg.startsWith('-')) root = arg;
  }
  return { apply, root };
}

function resolveStoreRoot(input) {
  const base = input ?? process.env.MEMSPEC_ROOT ?? join(process.cwd(), '.memspec');
  const abs = resolve(base);
  return basename(abs) === '.memspec' ? abs : join(abs, '.memspec');
}

function walkMarkdown(dir) {
  let out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out = out.concat(walkMarkdown(full));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

function asIdArray(value) {
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string');
  if (typeof value === 'string') return [value];
  return [];
}

function main() {
  const { apply, root } = parseArgs(process.argv.slice(2));
  if (root === '--help') {
    console.log('Usage: node bin/repair-inferred-conflicts.mjs [STORE_ROOT] [--apply]');
    return;
  }

  const storeRoot = resolveStoreRoot(root);
  if (!(() => { try { return statSync(storeRoot).isDirectory(); } catch { return false; } })()) {
    console.error(`[repair] store root not found: ${storeRoot}`);
    process.exitCode = 1;
    return;
  }

  const files = [
    ...walkMarkdown(join(storeRoot, 'memory')),
    ...walkMarkdown(join(storeRoot, 'archive')),
  ];

  const repaired = [];
  for (const file of files) {
    let parsed;
    try {
      parsed = matter(readFileSync(file, 'utf8'));
    } catch {
      continue; // non-memspec or unparseable markdown — skip
    }
    const data = parsed.data;
    const conflicts = asIdArray(data.conflicts_with);
    if (conflicts.length === 0) continue;

    const positive = new Set(POSITIVE_EDGES.flatMap((edge) => asIdArray(data[edge])));
    const dropped = conflicts.filter((id) => positive.has(id));
    if (dropped.length === 0) continue;

    const kept = conflicts.filter((id) => !positive.has(id));
    repaired.push({ file, id: data.id ?? '(no id)', dropped, kept });

    if (apply) {
      if (kept.length > 0) data.conflicts_with = kept;
      else delete data.conflicts_with;
      writeFileSync(file, matter.stringify(parsed.content, data));
    }
  }

  const mode = apply ? 'APPLIED' : 'DRY-RUN';
  console.log(`[repair] ${mode} — store ${storeRoot}`);
  console.log(`[repair] scanned ${files.length} record file(s)`);
  console.log(`[repair] ${repaired.length} record(s) carry a target in both conflicts_with and a positive edge`);
  for (const r of repaired.slice(0, 20)) {
    console.log(`  ${r.id}: drop conflicts_with ${r.dropped.join(', ')}${r.kept.length ? ` (keep ${r.kept.join(', ')})` : ''}`);
  }
  if (repaired.length > 20) console.log(`  ... and ${repaired.length - 20} more`);
  if (!apply && repaired.length > 0) {
    console.log('[repair] re-run with --apply to drop the inferred conflicts.');
  }
}

main();
