/**
 * v0.4 Phase 6 — graph export to JSONL / GraphML / DOT.
 *
 * Pure projection over the active record set (or active + superseded with the
 * --include-superseded flag). Never writes to the store. Output goes to stdout
 * so callers can pipe into Gephi, Cytoscape, graphviz, jq, etc.
 *
 * Node legend (DOT):
 *   fact      → box, blue
 *   decision  → diamond, orange
 *   procedure → ellipse, green
 *   file      → octagon, gray (synthetic; one per unique anchor path)
 *   question  → note, purple (v0.11; filled when resolved)
 *   stale     → dashed border (overlays the type colour)
 *   superseded → filled gray (only present with --include-superseded)
 *
 * Edge legend (DOT):
 *   supersedes      → red, dashed   (only present with --include-superseded)
 *   conflicts_with  → orange, dotted (emitted as-stored, not auto-mirrored)
 *   refines         → blue
 *   supports        → green
 *   depends_on      → purple
 *   derived_from    → brown, dashed (v0.11; inferred-from, not observed)
 *   distinct_from   → gray, dotted  (v0.13; compared, independent)
 *   answers         → purple, dotted (v0.11; question → answer record)
 *   anchors_to      → gray, thin    (memory → file synthetic node)
 *
 * Observations are excluded by default — they are point-in-time records, not
 * graph-relevant. The --types filter still operates on the {fact, decision,
 * procedure} set.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { CompositeStore } from '../lib/composite-store.js';
import { stringifyFrontMatter } from '../lib/safe-matter.js';
import { effectiveSourceKind } from '../lib/source.js';
import { descriptionOf, encodeOkfDocument, fileBackedEvidence, inertMarkdown, OKF_VERSION, readEvidenceBlob } from './okf.js';
import { MemspecStore } from '../lib/store.js';
import { MEMORY_TYPES, type MemoryItem, type MemoryType, type SourceKind, type VerifiedWith } from '../lib/types.js';

export const EXPORT_FORMATS = ['jsonl', 'graphml', 'dot'] as const;
export type ExportFormat = typeof EXPORT_FORMATS[number];

/**
 * `--format okf` is a different shape from the three graph formats: a bundle
 * of files (one OKF v0.2 concept per record, every state and kind) written to
 * `--out <dir>`, not a stream on stdout. It lives beside them in the CLI but
 * outside EXPORT_FORMATS so the stdout-only callers (MCP) keep their contract.
 */
export const OKF_FORMAT = 'okf';

export interface ExportOptions {
  cwd?: string;
  format: ExportFormat;
  includeSuperseded?: boolean;
  /** Comma-separated list parsed at the CLI boundary into an array. */
  types?: MemoryType[];
}

interface MemoryNode {
  kind: 'node';
  node_type: 'memory';
  id: string;
  type: MemoryType;
  title: string;
  source_kind: SourceKind;
  verified_with: VerifiedWith;
  stale: boolean;
  state: MemoryItem['state'];
}

interface FileNode {
  kind: 'node';
  node_type: 'file';
  id: string;
  path: string;
}

interface QuestionNode {
  kind: 'node';
  node_type: 'question';
  id: string;
  title: string;
  closed: boolean;
  state: 'open' | 'resolved';
}

type GraphNode = MemoryNode | FileNode | QuestionNode;

interface GraphEdge {
  kind: 'edge';
  from: string;
  to: string;
  type: 'supersedes' | 'conflicts_with' | 'refines' | 'supports' | 'depends_on' | 'derived_from' | 'distinct_from' | 'anchors_to' | 'answers';
}

interface GraphProjection {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

function witnessOf(item: MemoryItem): VerifiedWith {
  if (item.verified_with) return item.verified_with;
  if (item.anchors && item.anchors.length > 0) return 'anchor';
  return 'assertion';
}

function fileNodeId(path: string): string {
  return `file:${path}`;
}

/**
 * Build the in-memory graph projection. Edge dedup is per-(from,to,type)
 * triple. File anchor nodes are deduped by path — same file anchored from two
 * different records produces one file node and two `anchors_to` edges.
 */
function project(items: MemoryItem[], includeSuperseded: boolean, typesFilter: MemoryType[]): GraphProjection {
  const typeSet = new Set<MemoryType>(typesFilter);
  const includedStates: MemoryItem['state'][] = includeSuperseded ? ['active', 'superseded'] : ['active'];
  const stateSet = new Set<MemoryItem['state']>(includedStates);

  // First pass: which records pass the filter (drives node + edge inclusion).
  const includedById = new Map<string, MemoryItem>();
  for (const item of items) {
    if (!item.type) continue; // observations excluded
    if (!typeSet.has(item.type)) continue;
    if (!stateSet.has(item.state)) continue;
    includedById.set(item.id, item);
  }

  const nodes: GraphNode[] = [];
  const fileNodesByPath = new Map<string, FileNode>();
  const edgeKeys = new Set<string>();
  const edges: GraphEdge[] = [];

  const addEdge = (edge: GraphEdge): void => {
    const key = `${edge.from}|${edge.to}|${edge.type}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push(edge);
  };

  const addFileNode = (path: string): string => {
    const id = fileNodeId(path);
    if (!fileNodesByPath.has(path)) {
      fileNodesByPath.set(path, { kind: 'node', node_type: 'file', id, path });
    }
    return id;
  };

  for (const item of includedById.values()) {
    nodes.push({
      kind: 'node',
      node_type: 'memory',
      id: item.id,
      type: item.type as MemoryType,
      title: item.title,
      source_kind: effectiveSourceKind(item),
      verified_with: witnessOf(item),
      stale: item.stale ?? false,
      state: item.state,
    });

    // Typed-relation edges. Only emit edges whose target is also in the
    // projected set so we don't render dangling references.
    for (const target of item.refines ?? []) {
      if (includedById.has(target)) addEdge({ kind: 'edge', from: item.id, to: target, type: 'refines' });
    }
    for (const target of item.supports ?? []) {
      if (includedById.has(target)) addEdge({ kind: 'edge', from: item.id, to: target, type: 'supports' });
    }
    for (const target of item.depends_on ?? []) {
      if (includedById.has(target)) addEdge({ kind: 'edge', from: item.id, to: target, type: 'depends_on' });
    }
    for (const target of item.derived_from ?? []) {
      if (includedById.has(target)) addEdge({ kind: 'edge', from: item.id, to: target, type: 'derived_from' });
    }
    for (const target of item.conflicts_with ?? []) {
      if (includedById.has(target)) addEdge({ kind: 'edge', from: item.id, to: target, type: 'conflicts_with' });
    }
    for (const target of item.distinct_from ?? []) {
      if (includedById.has(target)) addEdge({ kind: 'edge', from: item.id, to: target, type: 'distinct_from' });
    }

    // Supersedes edges only appear when superseded records are included —
    // otherwise the target would be a dangling reference and a clean active
    // subgraph is preferable.
    if (includeSuperseded) {
      for (const target of item.supersedes ?? []) {
        if (includedById.has(target)) addEdge({ kind: 'edge', from: item.id, to: target, type: 'supersedes' });
      }
    }

    // Anchor edges (memory → synthetic file node).
    for (const anchor of item.anchors ?? []) {
      const fileId = addFileNode(anchor.file);
      addEdge({ kind: 'edge', from: item.id, to: fileId, type: 'anchors_to' });
    }
  }

  // v0.11 — question groups. Included regardless of the type/state filters
  // (they organise claims, not classify them); `answers` edges point at the
  // projected answer records that survived the filter.
  for (const item of items) {
    if (item.kind !== 'question') continue;
    nodes.push({
      kind: 'node',
      node_type: 'question',
      id: item.id,
      title: item.title,
      closed: item.closed === true,
      state: item.state === 'resolved' ? 'resolved' : 'open',
    });
    for (const answer of item.answers ?? []) {
      if (includedById.has(answer)) addEdge({ kind: 'edge', from: item.id, to: answer, type: 'answers' });
    }
  }

  // Append file nodes after memory nodes for stable, readable output.
  for (const fileNode of fileNodesByPath.values()) {
    nodes.push(fileNode);
  }

  return { nodes, edges };
}

// --- JSONL ---------------------------------------------------------------

/**
 * JSONL serialisation. Keys are emitted in a fixed, alphabetical order per
 * shape so the output is diff-friendly across runs.
 */
function renderJsonl(graph: GraphProjection): string {
  const lines: string[] = [];

  for (const node of graph.nodes) {
    if (node.node_type === 'memory') {
      // Alphabetised keys: id, kind, source_kind, stale, state, title, type, verified_with.
      lines.push(JSON.stringify({
        id: node.id,
        kind: 'node',
        node_type: 'memory',
        source_kind: node.source_kind,
        stale: node.stale,
        state: node.state,
        title: node.title,
        type: node.type,
        verified_with: node.verified_with,
      }));
    } else if (node.node_type === 'question') {
      lines.push(JSON.stringify({
        closed: node.closed,
        id: node.id,
        kind: 'node',
        node_type: 'question',
        state: node.state,
        title: node.title,
      }));
    } else {
      lines.push(JSON.stringify({
        id: node.id,
        kind: 'node',
        node_type: 'file',
        path: node.path,
      }));
    }
  }

  for (const edge of graph.edges) {
    lines.push(JSON.stringify({
      from: edge.from,
      kind: 'edge',
      to: edge.to,
      type: edge.type,
    }));
  }

  return `${lines.join('\n')}\n`;
}

// --- GraphML --------------------------------------------------------------

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Hand-rolled GraphML serialisation — Gephi and yEd both accept this shape.
 * Keys are declared up front; node and edge attributes reference them by id.
 */
function renderGraphml(graph: GraphProjection): string {
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<graphml xmlns="http://graphml.graphdrawing.org/xmlns" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://graphml.graphdrawing.org/xmlns http://graphml.graphdrawing.org/xmlns/1.0/graphml.xsd">');

  // Node attribute declarations.
  lines.push('  <key id="title" for="node" attr.name="title" attr.type="string"/>');
  lines.push('  <key id="node_type" for="node" attr.name="node_type" attr.type="string"/>');
  lines.push('  <key id="memory_type" for="node" attr.name="memory_type" attr.type="string"/>');
  lines.push('  <key id="source_kind" for="node" attr.name="source_kind" attr.type="string"/>');
  lines.push('  <key id="verified_with" for="node" attr.name="verified_with" attr.type="string"/>');
  lines.push('  <key id="stale" for="node" attr.name="stale" attr.type="boolean"/>');
  lines.push('  <key id="state" for="node" attr.name="state" attr.type="string"/>');
  lines.push('  <key id="closed" for="node" attr.name="closed" attr.type="boolean"/>');
  lines.push('  <key id="path" for="node" attr.name="path" attr.type="string"/>');

  // Edge attribute declarations.
  lines.push('  <key id="edge_type" for="edge" attr.name="edge_type" attr.type="string"/>');

  lines.push('  <graph id="memspec" edgedefault="directed">');

  for (const node of graph.nodes) {
    lines.push(`    <node id="${escapeXml(node.id)}">`);
    if (node.node_type === 'memory') {
      lines.push(`      <data key="node_type">memory</data>`);
      lines.push(`      <data key="memory_type">${escapeXml(node.type)}</data>`);
      lines.push(`      <data key="title">${escapeXml(node.title)}</data>`);
      lines.push(`      <data key="source_kind">${escapeXml(node.source_kind)}</data>`);
      lines.push(`      <data key="verified_with">${escapeXml(node.verified_with)}</data>`);
      lines.push(`      <data key="stale">${node.stale ? 'true' : 'false'}</data>`);
      lines.push(`      <data key="state">${escapeXml(node.state)}</data>`);
    } else if (node.node_type === 'question') {
      lines.push(`      <data key="node_type">question</data>`);
      lines.push(`      <data key="title">${escapeXml(node.title)}</data>`);
      lines.push(`      <data key="state">${escapeXml(node.state)}</data>`);
      lines.push(`      <data key="closed">${node.closed ? 'true' : 'false'}</data>`);
    } else {
      lines.push(`      <data key="node_type">file</data>`);
      lines.push(`      <data key="path">${escapeXml(node.path)}</data>`);
    }
    lines.push('    </node>');
  }

  let edgeIdx = 0;
  for (const edge of graph.edges) {
    lines.push(`    <edge id="e${edgeIdx}" source="${escapeXml(edge.from)}" target="${escapeXml(edge.to)}">`);
    lines.push(`      <data key="edge_type">${escapeXml(edge.type)}</data>`);
    lines.push('    </edge>');
    edgeIdx++;
  }

  lines.push('  </graph>');
  lines.push('</graphml>');
  return `${lines.join('\n')}\n`;
}

// --- DOT ------------------------------------------------------------------

function escapeDot(value: string): string {
  // graphviz strings — escape quotes and backslashes; collapse newlines to space.
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
}

interface DotNodeStyle {
  shape: string;
  color: string;
  fontcolor?: string;
  style?: string;
  fillcolor?: string;
}

function dotNodeStyle(node: GraphNode): DotNodeStyle {
  if (node.node_type === 'file') {
    return { shape: 'octagon', color: 'gray' };
  }
  if (node.node_type === 'question') {
    const style = node.state === 'resolved' ? 'rounded,filled' : 'rounded';
    return { shape: 'note', color: 'purple', style, fillcolor: node.state === 'resolved' ? 'lavender' : undefined };
  }

  let base: DotNodeStyle;
  switch (node.type) {
    case 'fact': base = { shape: 'box', color: 'blue' }; break;
    case 'decision': base = { shape: 'diamond', color: 'orange' }; break;
    case 'procedure': base = { shape: 'ellipse', color: 'green' }; break;
  }

  const styles: string[] = ['rounded'];
  if (node.stale) styles.push('dashed');
  if (node.state === 'superseded') {
    styles.push('filled');
    base.fillcolor = 'lightgray';
  }
  base.style = styles.join(',');
  return base;
}

interface DotEdgeStyle {
  color: string;
  style?: string;
  penwidth?: string;
}

function dotEdgeStyle(type: GraphEdge['type']): DotEdgeStyle {
  switch (type) {
    case 'supersedes': return { color: 'red', style: 'dashed' };
    case 'conflicts_with': return { color: 'orange', style: 'dotted' };
    case 'refines': return { color: 'blue' };
    case 'supports': return { color: 'green' };
    case 'depends_on': return { color: 'purple' };
    case 'derived_from': return { color: 'brown', style: 'dashed' };
    case 'distinct_from': return { color: 'gray', style: 'dotted' };
    case 'answers': return { color: 'purple', style: 'dotted' };
    case 'anchors_to': return { color: 'gray', penwidth: '0.5' };
  }
}

function renderDotAttrs(attrs: Record<string, string | undefined>): string {
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue;
    pairs.push(`${key}="${escapeDot(value)}"`);
  }
  return pairs.join(', ');
}

function renderDot(graph: GraphProjection): string {
  const lines: string[] = [];
  lines.push('digraph memspec {');
  lines.push('  rankdir=LR;');
  lines.push('  node [shape=box, style=rounded];');

  for (const node of graph.nodes) {
    const style = dotNodeStyle(node);
    const label = node.node_type === 'file' ? node.path : node.title;
    const attrs = renderDotAttrs({
      label,
      shape: style.shape,
      color: style.color,
      style: style.style,
      fillcolor: style.fillcolor,
      fontcolor: style.fontcolor,
    });
    lines.push(`  "${escapeDot(node.id)}" [${attrs}];`);
  }

  for (const edge of graph.edges) {
    const style = dotEdgeStyle(edge.type);
    const attrs = renderDotAttrs({
      label: edge.type,
      color: style.color,
      style: style.style,
      penwidth: style.penwidth,
    });
    lines.push(`  "${escapeDot(edge.from)}" -> "${escapeDot(edge.to)}" [${attrs}];`);
  }

  lines.push('}');
  return `${lines.join('\n')}\n`;
}

// --- Entry point ---------------------------------------------------------

/**
 * Read-only projection of the store into one of the three serialisation
 * formats. Caller redirects stdout; no file-output flag by design.
 */
export function runExport(options: ExportOptions): string {
  if (!(EXPORT_FORMATS as readonly string[]).includes(options.format)) {
    throw new Error(`Unsupported export format: ${options.format} (expected jsonl | graphml | dot)`);
  }

  const types = options.types && options.types.length > 0
    ? options.types
    : ([...MEMORY_TYPES] as MemoryType[]);

  for (const t of types) {
    if (!(MEMORY_TYPES as readonly string[]).includes(t)) {
      throw new Error(`Unsupported memory type in --types: ${t}`);
    }
  }

  const store = new MemspecStore(options.cwd);
  const items = store.loadAll();
  const graph = project(items, options.includeSuperseded === true, types);

  switch (options.format) {
    case 'jsonl': return renderJsonl(graph);
    case 'graphml': return renderGraphml(graph);
    case 'dot': return renderDot(graph);
  }
}

/**
 * CLI types parser shared with the MCP tool — accepts either a comma-separated
 * string or an already-parsed array.
 */
export function parseTypesArg(input: string | string[] | undefined): MemoryType[] | undefined {
  if (!input) return undefined;
  const raw = Array.isArray(input) ? input : input.split(',');
  const out: MemoryType[] = [];
  for (const piece of raw) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    if (!(MEMORY_TYPES as readonly string[]).includes(trimmed)) {
      throw new Error(`Unsupported memory type in --types: ${trimmed}`);
    }
    out.push(trimmed as MemoryType);
  }
  return out.length > 0 ? out : undefined;
}

// --- OKF bundle ----------------------------------------------------------

export interface ExportOkfOptions {
  cwd?: string;
  /** Target directory; must not exist or must be empty (a re-export never merges into old files). */
  out: string;
}

export interface ExportOkfResult {
  out: string;
  written: number;
  /** Records that could not be carried (id + reason); the rest of the bundle is still written. */
  skipped: Array<{ id: string; reason: string }>;
  /** Store files that failed to load (and layers that are missing), so are absent from the bundle. */
  unreadable: Array<{ file: string; reason: string }>;
  /**
   * File-backed evidence whose blob could not be copied (already missing or
   * altered in the source store). The record is still written; importing it
   * will refuse it until the blob is restored.
   */
  missingEvidence: Array<{ id: string; path: string; reason: string }>;
}

const OKF_INDEX_SECTIONS: Array<[string, (i: MemoryItem) => boolean]> = [
  ['Facts', (i) => i.kind === 'claim' && i.type === 'fact'],
  ['Decisions', (i) => i.kind === 'claim' && i.type === 'decision'],
  ['Procedures', (i) => i.kind === 'claim' && i.type === 'procedure'],
  ['Observations', (i) => i.kind === 'observation'],
  ['Questions', (i) => i.kind === 'question'],
];

/**
 * Write the whole store (all states, all kinds) as an OKF v0.2 bundle. Pure
 * projection: nothing in the store is touched. See `okf.ts` for the mapping.
 *
 * The store is the read view for `cwd` (`CompositeStore.forCwd`, the set
 * `search`/`context` read): a `.memspec.yaml` pointer or a `stores:` block
 * contributes every layer present on disk, each record read raw from its own
 * layer (no read-time view projections). An id held by several layers is
 * taken from the highest-priority one; the shadowed copies are listed in
 * `skipped`. Files that fail to load are listed in `unreadable`.
 *
 * The bundle is built in a sibling staging directory and renamed into place,
 * so a concurrent export to the same `--out` fails instead of merging, and a
 * failed export leaves nothing behind.
 */
export function runExportOkf(options: ExportOkfOptions): ExportOkfResult {
  const out = resolve(options.out);
  if (existsSync(out) && readdirSync(out).length > 0) {
    throw new Error(`--out ${out} is not empty; export into a new or empty directory`);
  }

  const view = CompositeStore.forCwd(options.cwd);
  const owner = new Map<string, MemspecStore>();
  const items: MemoryItem[] = [];
  const skipped: ExportOkfResult['skipped'] = [];
  for (const layer of view.layers) {
    if (!layer.store.exists) continue;
    for (const item of layer.store.loadAll()) {
      const held = owner.get(item.id);
      if (held) {
        skipped.push({ id: item.id, reason: `shadowed: also in higher-priority layer ${held.root}, exported from there (copy in ${layer.store.root} not carried)` });
        continue;
      }
      owner.set(item.id, layer.store);
      items.push(item);
    }
  }
  const unreadable = view.warnings.map((w) => ({ file: w.file, reason: w.reason }));
  items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const titles = new Map(items.map((i) => [i.id, i.title]));

  mkdirSync(dirname(out), { recursive: true });
  const stage = mkdtempSync(join(dirname(out), `.${basename(out)}.okf-`));
  try {
    chmodSync(stage, 0o755);
    const missingEvidence: ExportOkfResult['missingEvidence'] = [];
    const done: MemoryItem[] = [];
    for (const item of items) {
      try {
        const doc = encodeOkfDocument(item, (id) => titles.get(id));
        writeFileSync(join(stage, doc.path), stringifyFrontMatter(`${doc.body}\n`, doc.frontmatter));
        done.push(item);
      } catch (err) {
        skipped.push({ id: item.id, reason: err instanceof Error ? err.message : String(err) });
        continue;
      }
      for (const entry of fileBackedEvidence(item)) {
        try {
          const bytes = readEvidenceBlob(owner.get(item.id)!.root, entry);
          const dest = join(stage, entry.path!);
          mkdirSync(dirname(dest), { recursive: true });
          if (!existsSync(dest)) writeFileSync(dest, bytes);
        } catch (err) {
          missingEvidence.push({ id: item.id, path: String(entry.path), reason: err instanceof Error ? err.message : String(err) });
        }
      }
    }

    const lines: string[] = [];
    for (const [heading, match] of OKF_INDEX_SECTIONS) {
      const section = done.filter(match);
      if (section.length === 0) continue;
      lines.push(`# ${heading}`, '');
      for (const item of section) {
        const desc = descriptionOf(item.body);
        lines.push(`* [${inertMarkdown(item.title || item.id)}](${item.id}.md)${desc ? ` - ${inertMarkdown(desc)}` : ''}`);
      }
      lines.push('');
    }
    writeFileSync(join(stage, 'index.md'), stringifyFrontMatter(`${lines.join('\n')}\n`, { okf_version: OKF_VERSION }));

    try {
      // rename(2) replaces a missing or EMPTY directory and fails on a
      // non-empty one: a second exporter that raced past the check above
      // loses here instead of interleaving files with the first.
      renameSync(stage, out);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOTEMPTY' || code === 'EEXIST') {
        throw new Error(`--out ${out} was filled by another writer during the export; nothing was written`);
      }
      throw err;
    }
    return { out, written: done.length, skipped, unreadable, missingEvidence };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
