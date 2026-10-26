/**
 * Open Knowledge Format (OKF) v0.2 projection of the memory store, both ways.
 *
 * One OKF concept document per record, flat in the bundle root: the concept id
 * is the record id (`<id>.md`), so a typed edge to a record that is not in the
 * bundle (archived away, other store) still yields a well-formed link, and
 * OKF tolerates the broken target. Reserved files: a root `index.md` carrying
 * `okf_version` and per-type listings. No `log.md` (optional in the spec).
 *
 * Mapping (memspec -> OKF native field):
 *
 *   kind/type            -> `type`: Fact | Decision | Procedure | Observation | Question
 *   title                -> `title`
 *   first body line      -> `description` (projection only, never read back)
 *   tags                 -> `tags`
 *   state                -> `status`: active -> stable; superseded|retired ->
 *                           deprecated; question open -> draft, resolved -> stable
 *   check_by (ISO)       -> `stale_after` (an absolute instant, same meaning:
 *                           stale when now >= it). `check_by: never` has no OKF
 *                           equivalent, so `stale_after` is omitted
 *   source/source_kind   -> `generated.by` actor (operator -> human:<source>,
 *   + created               import -> process:<source>, agent -> <source>),
 *                           `generated.at` = created. Projection only.
 *   verified_with +      -> `verified: [{by, at}]`, one entry, at = last_verified
 *   last_verified           (default created). anchor|probe|evidence ->
 *                           process:<witness> (machine-confirmed tier);
 *                           operator -> human:operator (human-reviewed tier).
 *                           `assertion` (writer's own say-so) is NOT a
 *                           verification, so it emits no entry and stays
 *                           unverified; it is carried in the extension
 *   anchors              -> `sources` entries (resource = file, or repo:file)
 *   evidence             -> `sources` entries (resource = url or store path)
 *   typed edges          -> markdown links in a delimited `# Links` body block
 *                           (untyped in OKF; the edge kind is the prose after
 *                           the dash) AND `x-memspec.edges` (typed, authoritative)
 *   everything else      -> `x-memspec` extension (see below)
 *
 * Losslessness: the exporter builds the native OKF fields, runs the SAME
 * decoder the importer uses over them, and diffs the result against the real
 * record. Whatever the native fields cannot reproduce exactly (created,
 * source, valid_from/valid_to, scope, pinned, probe, ext, superseded states,
 * `assertion` witnesses, non-ISO check_by, ...) lands under `x-memspec`, with
 * keys the record lacks but the decoder would invent listed in
 * `x-memspec.absent`. The importer applies the same two steps in reverse, so
 * the round trip is lossless by construction, not by a hand-kept field list.
 *
 * Not carried: `stale` (derived from check_by at read time, re-flagged on the
 * first read of the imported store).
 *
 * Evidence blobs: a file-backed entry (`sha256` + `path`) is only a witness
 * while its content-addressed blob exists, so the exporter copies each blob
 * into the bundle at the same relative path (`evidence/<sha12>/<name>`, at most
 * 5 MB each) and the importer copies it back, checking the sha256. A record
 * whose blob is missing or altered is refused on import rather than landing
 * with a `verified_with: evidence` witness that points at nothing.
 */

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { EVIDENCE_DIR, isFileBackedEvidence } from '../lib/evidence.js';
import { effectiveSourceKind } from '../lib/source.js';
import type { CodeAnchor, EvidenceEntry, MemoryFrontmatter, MemoryItem, SourceKind } from '../lib/types.js';

export const OKF_VERSION = '0.2';
export const OKF_EXTENSION_KEY = 'x-memspec';
export const OKF_RESERVED_FILES = ['index.md', 'log.md'] as const;

const LINKS_BEGIN = '<!-- memspec:links -->';
const LINKS_END = '<!-- /memspec:links -->';
const LINKS_BLOCK = /\n\n<!-- memspec:links -->[\s\S]*?<!-- \/memspec:links -->\s*$/;

/** Edge fields, in emission order. `*_one` fields hold a single id, the rest arrays. */
const MULTI_EDGES = [
  'supersedes', 'conflicts_with', 'refines', 'supports', 'depends_on', 'derived_from', 'distinct_from', 'answers',
] as const;
const SINGLE_EDGES = ['superseded_by', 'resolved_by'] as const;
type EdgeType = typeof MULTI_EDGES[number] | typeof SINGLE_EDGES[number];
const EDGE_TYPES: readonly string[] = [...MULTI_EDGES, ...SINGLE_EDGES];

/** Frontmatter keys compared by the residue diff (title/body are native, stale is derived). */
const RESIDUE_KEYS = [
  'id', 'kind', 'type', 'state', 'created', 'source', 'source_kind', 'tags', 'scope', 'check_by',
  'last_verified', 'verified_with', 'pinned', 'anchors', 'probe',
  ...MULTI_EDGES, ...SINGLE_EDGES,
  'supersede_reason', 'requires_human', 'evidence', 'closed', 'expires', 'valid_from', 'valid_to', 'ext',
] as const;

const TYPE_NAME: Record<string, string> = {
  fact: 'Fact', decision: 'Decision', procedure: 'Procedure', observation: 'Observation', question: 'Question',
};

const WITNESS_ACTOR: Record<string, string> = {
  anchor: 'process:anchor', probe: 'process:probe', evidence: 'process:evidence', operator: 'human:operator',
};

type Obj = Record<string, unknown>;

/** A memspec record id (same pattern the frontmatter schema enforces on `id`). */
export const MEMSPEC_ID = /^ms_[A-Z0-9]{26}$/;

export interface OkfEdge { type: string; to: string }

/** The `x-memspec` extension block. */
export interface OkfExtension extends Obj {
  version: number;
  id: string;
  edges?: OkfEdge[];
  absent?: string[];
}

/** ISO 8601 instant with an explicit offset, or undefined when `s` is not an instant. */
export function toInstant(value: unknown): string | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  if (typeof value !== 'string') return undefined;
  if (!/^\d{4}-\d{2}-\d{2}/.test(value)) return undefined;
  // A datetime with no offset would be read as local time by Date.parse; OKF
  // wants an explicit offset, and a memspec timestamp without one is UTC.
  const hasOffset = /(Z|[+-]\d{2}:?\d{2})$/i.test(value);
  const ms = Date.parse(/T/.test(value) && !hasOffset ? `${value}Z` : value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

function actorFor(item: MemoryFrontmatter): string {
  const kind: SourceKind = effectiveSourceKind(item);
  // A source already in actor form (`human:siim`) is the actor id as-is.
  if (kind === 'operator') return /^human:/i.test(item.source) ? item.source : `human:${item.source}`;
  if (kind === 'import') return /^process:/i.test(item.source) ? item.source : `process:${item.source}`;
  return item.source;
}

/**
 * Record text placed inside generated markdown (index entries, Links labels):
 * one line, with the characters that open a link, image or inline HTML
 * escaped, so a title like `x](https://evil)[y` stays inert text.
 */
export function inertMarkdown(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(/[\\[\]<]/g, '\\$&');
}

function anchorResource(anchor: CodeAnchor): string {
  return anchor.repo ? `${anchor.repo}:${anchor.file}` : anchor.file;
}

export function descriptionOf(body: string): string | undefined {
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const flat = line.replace(/\s+/g, ' ');
    return flat.length > 200 ? `${flat.slice(0, 197)}...` : flat;
  }
  return undefined;
}

function pick(item: MemoryFrontmatter, field: EdgeType): string[] {
  const v = (item as unknown as Obj)[field];
  if (typeof v === 'string') return [v];
  return Array.isArray(v) ? (v as string[]) : [];
}

function edgesOf(item: MemoryFrontmatter): OkfEdge[] {
  const out: OkfEdge[] = [];
  for (const type of [...MULTI_EDGES, ...SINGLE_EDGES]) {
    for (const to of pick(item, type)) out.push({ type, to });
  }
  return out;
}

function nativeStatus(item: MemoryFrontmatter): string {
  if (item.kind === 'question') return item.state === 'resolved' ? 'stable' : 'draft';
  return item.state === 'active' ? 'stable' : 'deprecated';
}

function nativeType(item: MemoryFrontmatter): string {
  if (item.kind === 'observation') return TYPE_NAME.observation;
  if (item.kind === 'question') return TYPE_NAME.question;
  return TYPE_NAME[item.type ?? 'fact'];
}

function nativeSources(item: MemoryFrontmatter): Obj[] {
  const sources: Obj[] = [];
  (item.anchors ?? []).forEach((anchor, i) => {
    sources.push({
      id: `anchor-${i + 1}`,
      resource: anchorResource(anchor),
      title: `Code anchor: ${anchor.file}`,
      [OKF_EXTENSION_KEY]: { kind: 'anchor', file: anchor.file, sha: anchor.sha, ...(anchor.repo ? { repo: anchor.repo } : {}) },
    });
  });
  (item.evidence ?? []).forEach((entry, i) => {
    const resource = entry.url ?? entry.path ?? entry.name ?? 'evidence';
    const source: Obj = {
      id: `evidence-${i + 1}`,
      resource,
      [OKF_EXTENSION_KEY]: { kind: 'evidence', entry },
    };
    if (entry.name) source.title = entry.name;
    const captured = toInstant(entry.captured_at);
    if (captured) source.last_modified = captured;
    sources.push(source);
  });
  return sources;
}

/** What a consumer of the native fields alone reconstructs. Shared by encode (diff) and decode (import). */
export interface NativeDecode {
  fm: Obj;
  title: string;
  body: string;
}

function decodeNative(doc: Obj, rawBody: string, edges: OkfEdge[]): NativeDecode {
  const fm: Obj = {};
  const typeName = String(doc.type ?? '');
  const lower = typeName.toLowerCase();
  if (lower === 'observation') fm.kind = 'observation';
  else if (lower === 'question') fm.kind = 'question';
  else {
    fm.kind = 'claim';
    if (lower === 'fact' || lower === 'decision' || lower === 'procedure') fm.type = lower;
  }

  const tags = doc.tags;
  fm.tags = Array.isArray(tags) ? tags.map(String) : [];

  const stale = toInstant(doc.stale_after);
  if (stale) fm.check_by = stale;

  const status = doc.status;
  if (fm.kind === 'question') fm.state = status === 'draft' ? 'open' : 'resolved';
  else if (status === 'deprecated') fm.state = edges.some((e) => e.type === 'superseded_by') ? 'superseded' : 'retired';
  else fm.state = 'active';

  const verified = Array.isArray(doc.verified) ? doc.verified : doc.verified ? [doc.verified] : [];
  let latest: { by: string; at: string } | undefined;
  for (const entry of verified as Obj[]) {
    const at = toInstant(entry?.at);
    if (at && typeof entry.by === 'string' && (!latest || at > latest.at)) latest = { by: entry.by, at };
  }
  if (latest) {
    fm.last_verified = latest.at;
    const witness = Object.entries(WITNESS_ACTOR).find(([, actor]) => actor === latest!.by)?.[0];
    if (witness) fm.verified_with = witness;
    else if (latest.by.startsWith('human:')) fm.verified_with = 'operator';
  }

  const anchors: CodeAnchor[] = [];
  const evidence: EvidenceEntry[] = [];
  for (const source of (Array.isArray(doc.sources) ? doc.sources : []) as Obj[]) {
    const ext = source?.[OKF_EXTENSION_KEY] as Obj | undefined;
    if (ext?.kind === 'anchor') {
      anchors.push({ file: String(ext.file), sha: String(ext.sha), ...(ext.repo ? { repo: String(ext.repo) } : {}) });
    } else if (ext?.kind === 'evidence' && ext.entry && typeof ext.entry === 'object') {
      evidence.push(ext.entry as EvidenceEntry);
    }
  }
  if (anchors.length > 0) fm.anchors = anchors;
  if (evidence.length > 0) fm.evidence = evidence;

  for (const edge of edges) {
    if ((SINGLE_EDGES as readonly string[]).includes(edge.type)) fm[edge.type] = edge.to;
    else if (EDGE_TYPES.includes(edge.type)) ((fm[edge.type] ??= []) as string[]).push(edge.to);
  }

  const body = rawBody.replace(LINKS_BLOCK, '').trim();
  const title = typeof doc.title === 'string' ? doc.title : (body.match(/^#\s+(.+)$/m)?.[1].trim() ?? '');
  return { fm, title, body };
}

const plain = (value: unknown): unknown => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

export interface OkfDocument {
  /** Bundle-relative path, `<id>.md`. */
  path: string;
  frontmatter: Obj;
  body: string;
}

/** Encode one record as an OKF concept document. Throws when the body cannot be carried verbatim. */
export function encodeOkfDocument(item: MemoryItem, titleOf: (id: string) => string | undefined = () => undefined): OkfDocument {
  if (item.body.includes(LINKS_BEGIN) || item.body.includes(LINKS_END)) {
    throw new Error(`body contains the reserved OKF links marker "${LINKS_BEGIN}"`);
  }
  const edges = edgesOf(item);
  const original = plain(item) as Obj;

  const doc: Obj = { type: nativeType(item) };
  if (item.title) doc.title = item.title;
  const description = descriptionOf(item.body);
  if (description) doc.description = description;
  if (item.tags && item.tags.length > 0) doc.tags = item.tags;
  doc.status = nativeStatus(item);

  const created = toInstant(item.created);
  doc.generated = created ? { by: actorFor(item), at: created } : { by: actorFor(item) };

  const witness = item.verified_with;
  const witnessActor = witness ? WITNESS_ACTOR[witness] : undefined;
  if (witnessActor) {
    const at = toInstant(item.last_verified ?? item.created);
    if (at) doc.verified = [{ by: witnessActor, at }];
  }

  const stale = item.check_by === 'never' ? undefined : toInstant(item.check_by);
  if (stale) doc.stale_after = stale;

  const sources = nativeSources(item);
  if (sources.length > 0) doc.sources = sources;

  let body = item.body.trim();
  // Edge targets are not schema-checked (a hand-edited `refines: ['x) [evil](https://...)']`
  // loads fine), and the target is spliced into a link destination, so only a
  // well-formed memspec id gets a link. Every edge, linked or not, still travels
  // typed in `x-memspec.edges`.
  const linkable = edges.filter((e) => MEMSPEC_ID.test(e.to));
  if (linkable.length > 0) {
    const lines = linkable.map((e) => `* [${inertMarkdown(titleOf(e.to) ?? e.to)}](/${e.to}.md) - ${e.type}`);
    body = `${body}\n\n${LINKS_BEGIN}\n## Links\n\n${lines.join('\n')}\n${LINKS_END}`;
  }

  // Residue: whatever the native fields do not reproduce exactly.
  const decoded = decodeNative(doc, body, edges).fm;
  const ext: OkfExtension = { version: 1, id: item.id };
  if (edges.length > 0) ext.edges = edges;
  const absent: string[] = [];
  for (const key of RESIDUE_KEYS) {
    if (key === 'id') continue;
    const have = original[key];
    const got = plain(decoded[key]);
    if (isDeepStrictEqual(have, got)) continue;
    if (have === undefined) absent.push(key);
    else ext[key] = have;
  }
  if (absent.length > 0) ext.absent = absent;
  doc[OKF_EXTENSION_KEY] = ext;

  return { path: `${item.id}.md`, frontmatter: doc, body };
}

export interface OkfDecoded {
  frontmatter: Obj;
  title: string;
  body: string;
}

export class OkfNotMemspecError extends Error {}

/** YAML turns an unquoted ISO timestamp into a Date; memspec frontmatter holds strings. */
function datesToIso(value: unknown): unknown {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? value : value.toISOString();
  if (Array.isArray(value)) return value.map(datesToIso);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Obj).map(([k, v]) => [k, datesToIso(v)]));
  }
  return value;
}

/**
 * Decode a parsed OKF concept document produced by `encodeOkfDocument`.
 * Throws `OkfNotMemspecError` for a document memspec did not write (no
 * extension, or no front matter at all), and a plain Error for a memspec
 * document whose native fields are not valid OKF or not a shape the exporter
 * emits: the native `type` and `status` decide kind and state, so an edited
 * value must be refused, not read as the default.
 */
export function decodeOkfDocument(doc: Obj | null | undefined, rawBody: string): OkfDecoded {
  const ext = doc && typeof doc === 'object' ? (doc[OKF_EXTENSION_KEY] as OkfExtension | undefined) : undefined;
  if (!doc || !ext || typeof ext !== 'object' || typeof ext.id !== 'string') {
    throw new OkfNotMemspecError(`no ${OKF_EXTENSION_KEY} extension with an id (not produced by memspec export)`);
  }
  const problems = validateOkfConcept(doc);
  if (typeof doc.type === 'string' && !Object.values(TYPE_NAME).includes(doc.type)) {
    problems.push(`type ${doc.type} is not one memspec exports (${Object.values(TYPE_NAME).join(', ')})`);
  }
  // The exporter always writes `status`; a missing one would decode as active
  // (or a resolved question) and silently reactivate a deprecated record.
  // Only an extension that carries the state itself makes it redundant.
  if ((doc.status === undefined || doc.status === null) && ext.state === undefined) {
    problems.push('missing `status` (and no x-memspec.state to take the state from)');
  }
  if (problems.length > 0) throw new Error(`not a valid memspec OKF concept: ${problems.join('; ')}`);
  const edges = (Array.isArray(ext.edges) ? ext.edges : []).filter(
    (e): e is OkfEdge => !!e && typeof e.type === 'string' && typeof e.to === 'string',
  );
  const { fm, title, body } = decodeNative(doc, rawBody, edges);
  const merged: Obj = { id: ext.id, ...fm };
  const reserved = new Set(['version', 'id', 'edges', 'absent']);
  for (const [key, value] of Object.entries(ext)) {
    if (!reserved.has(key)) merged[key] = value;
  }
  for (const [key, value] of Object.entries(merged)) merged[key] = datesToIso(value);
  for (const key of Array.isArray(ext.absent) ? ext.absent : []) delete merged[key];
  return { frontmatter: merged, title, body };
}

/**
 * Check a bundle's parsed concept documents against the OKF v0.2 required
 * fields (§11) and the shape constraints of the families this exporter emits
 * (§5). Returns human-readable problems; empty means conformant.
 */
export function validateOkfConcept(doc: Obj): string[] {
  const problems: string[] = [];
  if (typeof doc.type !== 'string' || doc.type.trim() === '') problems.push('missing non-empty `type`');
  const instant = (v: unknown): boolean => (v instanceof Date && !Number.isNaN(v.getTime()))
    || (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/.test(v) && !Number.isNaN(Date.parse(v)));
  if (doc.status !== undefined && !['draft', 'stable', 'deprecated'].includes(String(doc.status))) problems.push(`invalid status ${String(doc.status)}`);
  if (doc.stale_after !== undefined && !instant(doc.stale_after)) problems.push('stale_after is not an ISO 8601 instant with offset');
  if (doc.tags !== undefined && !Array.isArray(doc.tags)) problems.push('tags is not a list');
  if (doc.generated !== undefined) {
    const g = doc.generated as Obj;
    if (!g || typeof g.by !== 'string' || !g.by) problems.push('generated.by missing');
    if (g && g.at !== undefined && !instant(g.at)) problems.push('generated.at is not an instant with offset');
  }
  if (doc.verified !== undefined) {
    const list = Array.isArray(doc.verified) ? doc.verified : [doc.verified];
    for (const v of list as Obj[]) {
      if (!v || typeof v.by !== 'string' || !instant(v.at)) problems.push('verified entry needs by + at (instant with offset)');
    }
  }
  if (doc.sources !== undefined) {
    if (!Array.isArray(doc.sources)) problems.push('sources is not a list');
    else for (const s of doc.sources as Obj[]) {
      if (!s || typeof s.resource !== 'string' || !s.resource) problems.push('sources entry missing resource');
      if (s && s.last_modified !== undefined && !instant(s.last_modified)) problems.push('sources[].last_modified is not an instant with offset');
    }
  }
  return problems;
}

const EVIDENCE_PATH = new RegExp(`^${EVIDENCE_DIR}/([0-9a-f]{12})/([^/\\\\]+)$`);

/**
 * The bytes of a file-backed evidence entry's blob under `root` (a store or a
 * bundle), checked against the entry: the path must be the content-addressed
 * `evidence/<sha256[:12]>/<name>` shape (no traversal), the file a regular
 * non-symlink file, and its sha256 the recorded one. Throws with the reason.
 */
export function readEvidenceBlob(root: string, entry: EvidenceEntry): Buffer {
  const m = EVIDENCE_PATH.exec(entry.path ?? '');
  if (!isFileBackedEvidence(entry) || !m || m[2] === '.' || m[2] === '..' || m[1] !== entry.sha256!.slice(0, 12)) {
    throw new Error(`evidence entry path ${String(entry.path)} is not ${EVIDENCE_DIR}/<sha256[:12]>/<name> for its sha256`);
  }
  const file = join(root, entry.path!);
  if (!existsSync(file)) throw new Error(`evidence blob ${entry.path} is missing`);
  const stat = lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`evidence blob ${entry.path} is not a regular file`);
  const bytes = readFileSync(file);
  if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
    throw new Error(`evidence blob ${entry.path} does not match its sha256`);
  }
  return bytes;
}

/** File-backed evidence entries of a record (those with a blob to carry). */
export function fileBackedEvidence(item: { evidence?: EvidenceEntry[] }): EvidenceEntry[] {
  return (item.evidence ?? []).filter(isFileBackedEvidence);
}
