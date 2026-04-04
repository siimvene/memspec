import matter from 'gray-matter';
import type { MemoryFrontmatter, MemoryItem } from './types.js';
import { assertValidFrontmatter } from './schema.js';

function coerceDates(data: Record<string, unknown>): Record<string, unknown> {
  const result = { ...data };
  for (const key of ['created', 'decay_after']) {
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
    type: data.type,
    state: data.state,
    confidence: data.confidence,
    created: data.created,
    source: data.source,
    tags: data.tags,
    decay_after: data.decay_after,
    corrects: data.corrects,
    corrected_by: data.corrected_by,
    ext: data.ext,
    title,
    body: body.trim(),
    filePath,
  };
}

export function serializeMemoryFile(item: MemoryFrontmatter & { title: string; body: string }): string {
  const frontmatter: Record<string, unknown> = {
    id: item.id,
    type: item.type,
    state: item.state,
    confidence: item.confidence,
    created: item.created,
    source: item.source,
    tags: item.tags,
    decay_after: item.decay_after,
  };

  if (item.corrects) frontmatter.corrects = item.corrects;
  if (item.corrected_by) frontmatter.corrected_by = item.corrected_by;
  if (item.ext && Object.keys(item.ext).length > 0) frontmatter.ext = item.ext;

  // Strip leading heading if it matches the title to avoid duplication
  let content = item.body.trim();
  const headingPattern = new RegExp(`^#\\s+${item.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\n?`);
  content = content.replace(headingPattern, '').trim();

  const body = [`# ${item.title}`, '', content].join('\n').trimEnd() + '\n';
  return matter.stringify(body, frontmatter);
}
