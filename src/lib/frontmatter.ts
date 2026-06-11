import matter from 'gray-matter';
import type { MemoryFrontmatter, MemoryItem } from './types.js';
import { assertValidFrontmatter } from './schema.js';

const LEGACY_DATE_KEYS = ['decay_after'] as const;
const DATE_KEYS = ['created', 'check_by', 'last_verified', 'expires', ...LEGACY_DATE_KEYS] as const;

function coerceDates(data: Record<string, unknown>): Record<string, unknown> {
  const result = { ...data };
  for (const key of DATE_KEYS) {
    if (result[key] instanceof Date) {
      result[key] = (result[key] as Date).toISOString();
    }
  }
  return result;
}

export function parseMemoryFile(content: string, filePath: string): MemoryItem {
  const parsed = matter(content);
  const data = assertValidFrontmatter(coerceDates(parsed.data as Record<string, unknown>));
  const body = parsed.content.trim();

  // Extract title from first heading
  const titleMatch = body.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : '';

  return {
    id: data.id,
    kind: data.kind,
    type: data.type,
    state: data.state,
    created: data.created,
    source: data.source,
    source_kind: data.source_kind,
    tags: data.tags,
    check_by: data.check_by,
    stale: data.stale,
    last_verified: data.last_verified,
    verified_with: data.verified_with,
    pinned: data.pinned,
    anchors: data.anchors,
    supersedes: data.supersedes,
    superseded_by: data.superseded_by,
    supersede_reason: data.supersede_reason,
    conflicts_with: data.conflicts_with,
    expires: data.expires,
    ext: data.ext,
    title,
    body: body.trim(),
    filePath,
  };
}

export function serializeMemoryFile(item: MemoryFrontmatter & { title: string; body: string }): string {
  const frontmatter: Record<string, unknown> = {
    id: item.id,
    kind: item.kind,
  };

  if (item.type) frontmatter.type = item.type;
  frontmatter.state = item.state;
  frontmatter.created = item.created;
  frontmatter.source = item.source;
  if (item.source_kind) frontmatter.source_kind = item.source_kind;
  frontmatter.tags = item.tags;
  frontmatter.check_by = item.check_by;

  if (item.stale) frontmatter.stale = item.stale;
  if (item.last_verified) frontmatter.last_verified = item.last_verified;
  if (item.verified_with) frontmatter.verified_with = item.verified_with;
  if (item.pinned) frontmatter.pinned = item.pinned;
  if (item.anchors && item.anchors.length > 0) frontmatter.anchors = item.anchors;
  if (item.supersedes && item.supersedes.length > 0) frontmatter.supersedes = item.supersedes;
  if (item.superseded_by) frontmatter.superseded_by = item.superseded_by;
  if (item.supersede_reason) frontmatter.supersede_reason = item.supersede_reason;
  if (item.conflicts_with && item.conflicts_with.length > 0) frontmatter.conflicts_with = item.conflicts_with;
  if (item.expires) frontmatter.expires = item.expires;
  if (item.ext && Object.keys(item.ext).length > 0) frontmatter.ext = item.ext;

  // Strip leading heading if it matches the title to avoid duplication
  let content = item.body.trim();
  const headingPattern = new RegExp(`^#\\s+${item.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\n?`);
  content = content.replace(headingPattern, '').trim();

  const body = [`# ${item.title}`, '', content].join('\n').trimEnd() + '\n';
  return matter.stringify(body, frontmatter);
}
