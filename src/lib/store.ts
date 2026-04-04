import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defaultConfigYaml, type ConfigGenerationOptions } from './config.js';
import { FtsIndex } from './fts.js';
import { parseMemoryFile, serializeMemoryFile } from './frontmatter.js';
import { validateFrontmatter } from './schema.js';
import type { MemoryFrontmatter, MemoryItem, MemoryType } from './types.js';
import matter from 'gray-matter';

function walkMarkdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];

  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkMarkdownFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(fullPath);
    }
  }

  return results;
}

export interface StoreSearchOptions {
  limit?: number;
  types?: MemoryType[];
  minConfidence?: number;
  ranking?: {
    relevance?: number;
    confidence?: number;
    recency?: number;
  };
}

export interface LoadWarning {
  file: string;
  reason: string;
}

export class MemspecStore {
  readonly root: string;
  readonly warnings: LoadWarning[] = [];

  constructor(root?: string) {
    this.root = root ? resolve(root, '.memspec') : this.findRoot();
  }

  private findRoot(): string {
    let dir = process.cwd();
    while (dir !== '/') {
      const candidate = join(dir, '.memspec');
      if (existsSync(candidate)) return candidate;
      dir = resolve(dir, '..');
    }
    return join(process.cwd(), '.memspec');
  }

  get exists(): boolean {
    return existsSync(this.root);
  }

  get configPath(): string {
    return join(this.root, 'config.yaml');
  }

  init(configOptions?: ConfigGenerationOptions): void {
    const dirs = [
      this.root,
      join(this.root, 'observations'),
      join(this.root, 'memory', 'facts'),
      join(this.root, 'memory', 'decisions'),
      join(this.root, 'memory', 'procedures'),
      join(this.root, 'archive'),
    ];

    for (const dir of dirs) {
      mkdirSync(dir, { recursive: true });
    }

    if (!existsSync(this.configPath)) {
      writeFileSync(this.configPath, defaultConfigYaml(configOptions));
    }
  }

  typeDir(type: MemoryType): string {
    return join(this.root, 'memory', `${type}s`);
  }

  observationDir(): string {
    return join(this.root, 'observations');
  }

  private pathForItem(item: MemoryFrontmatter): string {
    if (item.state === 'captured') {
      return join(this.observationDir(), `${item.id}.md`);
    }
    return join(this.typeDir(item.type), `${item.id}.md`);
  }

  writeItem(item: MemoryFrontmatter & { title: string; body: string }): string {
    const filePath = this.pathForItem(item);
    const dir = resolve(filePath, '..');
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, serializeMemoryFile(item));
    return filePath;
  }

  loadAll(): MemoryItem[] {
    const files = [
      ...walkMarkdownFiles(join(this.root, 'memory')),
      ...walkMarkdownFiles(join(this.root, 'observations')),
      ...walkMarkdownFiles(join(this.root, 'archive')),
    ];

    this.warnings.length = 0;
    const items: MemoryItem[] = [];

    for (const file of files) {
      try {
        const raw = readFileSync(file, 'utf8');
        const parsed = matter(raw);
        const data = parsed.data as Record<string, unknown>;

        // Coerce dates before validation
        for (const key of ['created', 'decay_after']) {
          if (data[key] instanceof Date) {
            data[key] = (data[key] as Date).toISOString();
          }
        }

        const result = validateFrontmatter(data);
        if (!result.success) {
          this.warnings.push({ file, reason: `Invalid frontmatter: ${result.errors.join('; ')}` });
          continue;
        }

        items.push(parseMemoryFile(raw, file));
      } catch (err) {
        this.warnings.push({ file, reason: err instanceof Error ? err.message : String(err) });
      }
    }

    return items;
  }

  loadActive(): MemoryItem[] {
    return this.loadAll().filter((item) => item.state === 'active');
  }

  findById(id: string): MemoryItem | null {
    return this.loadAll().find((item) => item.id === id) ?? null;
  }

  moveToArchive(item: MemoryItem, state: MemoryItem['state'] = 'archived'): void {
    const archivePath = join(this.root, 'archive', `${item.id}.md`);
    writeFileSync(
      archivePath,
      serializeMemoryFile({
        ...item,
        state,
      }),
    );
    if (item.filePath !== archivePath && existsSync(item.filePath)) {
      unlinkSync(item.filePath);
    }
  }

  updateItem(item: MemoryItem): void {
    writeFileSync(item.filePath, serializeMemoryFile(item));
  }

  search(query: string, options: StoreSearchOptions = {}): MemoryItem[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];

    const {
      limit = 10,
      types,
      minConfidence = 0,
      ranking,
    } = options;

    const activeItems = this.loadActive();

    // Build FTS5 index and search
    const fts = new FtsIndex();
    try {
      fts.populate(activeItems);
      const matches = fts.search(query, { limit: limit * 2, types, minConfidence });

      if (matches.length === 0) return [];

      const itemMap = new Map(activeItems.map((item) => [item.id, item]));
      const relevanceWeight = ranking?.relevance ?? 1;
      const confidenceWeight = ranking?.confidence ?? 0;
      const recencyWeight = ranking?.recency ?? 0;
      const now = Date.now();
      const phrase = terms.join(' ');

      const scored = matches.map(({ id, bm25Score }) => {
        const item = itemMap.get(id);
        if (!item) return null;

        // FTS5 rank: bm25() returns negative values, so invert it.
        const ftsScore = -bm25Score;

        const titleLower = item.title.toLowerCase();
        const tagsLower = item.tags.join(' ').toLowerCase();
        const bodyLower = item.body.toLowerCase();
        let phraseBonus = 0;
        if (terms.length > 1) {
          if (titleLower.includes(phrase)) phraseBonus = 5;
          else if (tagsLower.includes(phrase)) phraseBonus = 4;
          else if (bodyLower.includes(phrase)) phraseBonus = 3;
        }

        const ageMs = Math.max(0, now - Date.parse(item.created));
        const ageDays = ageMs / (24 * 60 * 60 * 1000);
        const recency = 1 / (1 + ageDays);

        const score =
          ((ftsScore + phraseBonus) * relevanceWeight) +
          (item.confidence * confidenceWeight) +
          (recency * recencyWeight);

        return { item, score };
      }).filter((entry): entry is { item: MemoryItem; score: number } => entry !== null);

      return scored
        .sort((a, b) => b.score - a.score || b.item.confidence - a.item.confidence)
        .slice(0, limit)
        .map(({ item }) => item);
    } finally {
      fts.close();
    }
  }
}
