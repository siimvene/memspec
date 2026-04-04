import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import { validateFrontmatter } from '../lib/schema.js';
import { MemspecStore } from '../lib/store.js';

function coerceDates(data: Record<string, unknown>): Record<string, unknown> {
  const result = { ...data };
  for (const key of ['created', 'decay_after']) {
    if (result[key] instanceof Date) {
      result[key] = (result[key] as Date).toISOString();
    }
  }
  return result;
}

function walk(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) return walk(entryPath);
      return entry.isFile() && entry.name.endsWith('.md') ? [entryPath] : [];
    });
  } catch {
    return [];
  }
}

export interface ValidateOptions {
  cwd?: string;
}

export function runValidate(options: ValidateOptions): string {
  const store = new MemspecStore(options.cwd);
  const files = [
    ...walk(join(store.root, 'memory')),
    ...walk(join(store.root, 'observations')),
    ...walk(join(store.root, 'archive')),
  ];

  const errors: string[] = [];
  const skipped: string[] = [];
  let validCount = 0;

  for (const file of files) {
    const parsed = matter(readFileSync(file, 'utf8'));
    const data = coerceDates(parsed.data as Record<string, unknown>);

    // If file has no memspec-shaped frontmatter at all (no id field), skip gracefully
    if (!data.id && !data.type && !data.state) {
      skipped.push(file);
      continue;
    }

    const result = validateFrontmatter(data);
    if (!result.success) {
      errors.push(`${file}: ${result.errors.join('; ')}`);
    } else {
      validCount++;
    }
  }

  const lines: string[] = [];

  if (errors.length > 0) {
    lines.push(`Validation failed (${errors.length} error(s)):`);
    lines.push(...errors);
  }

  if (skipped.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(`Skipped ${skipped.length} non-memspec file(s)`);
  }

  if (errors.length > 0) {
    throw new Error(lines.join('\n'));
  }

  const parts = [`${validCount} memspec file(s) valid`];
  if (skipped.length > 0) parts.push(`${skipped.length} non-memspec file(s) skipped`);
  return parts.join(', ');
}
