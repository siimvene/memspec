import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defaultConfigYaml } from './config.js';
import { parseMemoryFile, serializeMemoryFile } from './frontmatter.js';
import type { MemoryFrontmatter, MemoryItem, MemoryType } from './types.js';

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

export class MemspecStore {
  readonly root: string;

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

  init(): void {
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
      writeFileSync(this.configPath, defaultConfigYaml());
    }
  }

  typeDir(type: MemoryType): string {
    return join(this.root, 'memory', `${type}s`);
  }

  writeItem(item: MemoryFrontmatter & { title: string; body: string }): string {
    const dir = this.typeDir(item.type);
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, `${item.id}.md`);
    writeFileSync(filePath, serializeMemoryFile(item));
    return filePath;
  }

  loadAll(): MemoryItem[] {
    const files = [
      ...walkMarkdownFiles(join(this.root, 'memory')),
      ...walkMarkdownFiles(join(this.root, 'archive')),
    ];

    return files.map((file) => parseMemoryFile(readFileSync(file, 'utf8'), file));
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

  search(query: string, limit: number = 10, type?: MemoryType): MemoryItem[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];

    const scored = this.loadActive()
      .filter((item) => !type || item.type === type)
      .map((item) => {
        const searchable = [item.title, item.body, item.tags.join(' ')].join(' ').toLowerCase();
        let score = 0;
        for (const term of terms) {
          if (item.title.toLowerCase().includes(term)) score += 3;
          else if (item.tags.join(' ').toLowerCase().includes(term)) score += 2;
          else if (searchable.includes(term)) score += 1;
        }
        return { item, score };
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return scored.map(({ item }) => item);
  }
}
