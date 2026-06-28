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
 *   stale     → dashed border (overlays the type colour)
 *   superseded → filled gray (only present with --include-superseded)
 *
 * Edge legend (DOT):
 *   supersedes      → red, dashed   (only present with --include-superseded)
 *   conflicts_with  → orange, dotted (emitted as-stored, not auto-mirrored)
 *   refines         → blue
 *   supports        → green
 *   depends_on      → purple
 *   anchors_to      → gray, thin    (memory → file synthetic node)
 *
 * Observations are excluded by default — they are point-in-time records, not
 * graph-relevant. The --types filter still operates on the {fact, decision,
 * procedure} set.
 */

import { effectiveSourceKind } from '../lib/source.js';
import { MemspecStore } from '../lib/store.js';
import { MEMORY_TYPES, type MemoryItem, type MemoryType, type SourceKind, type VerifiedWith } from '../lib/types.js';

export const EXPORT_FORMATS = ['jsonl', 'graphml', 'dot'] as const;
export type ExportFormat = typeof EXPORT_FORMATS[number];

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

type GraphNode = MemoryNode | FileNode;

interface GraphEdge {
  kind: 'edge';
  from: string;
  to: string;
  type: 'supersedes' | 'conflicts_with' | 'refines' | 'supports' | 'depends_on' | 'anchors_to';
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
    for (const target of item.conflicts_with ?? []) {
      if (includedById.has(target)) addEdge({ kind: 'edge', from: item.id, to: target, type: 'conflicts_with' });
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
    const label = node.node_type === 'memory' ? node.title : node.path;
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
