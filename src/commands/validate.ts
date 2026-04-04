import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import { validateFrontmatter } from '../lib/schema.js';
import { MemspecStore } from '../lib/store.js';

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
    ...walk(join(store.root, 'archive')),
  ];

  const errors: string[] = [];

  for (const file of files) {
    const parsed = matter(readFileSync(file, 'utf8'));
    const result = validateFrontmatter(parsed.data);
    if (!result.success) {
      errors.push(`${file}: ${result.errors.join('; ')}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Validation failed\n${errors.join('\n')}`);
  }

  return `Validation passed (${files.length} files checked)`;
}
