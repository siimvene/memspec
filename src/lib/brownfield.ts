import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { ulid } from 'ulid';
import { getDecayDays, loadConfig } from './config.js';
import { MemspecStore } from './store.js';
import type { LifecycleState, MemoryFrontmatter, MemoryType } from './types.js';
import matter from 'gray-matter';

interface DraftItem extends MemoryFrontmatter {
  title: string;
  body: string;
}

export interface BrownfieldResult {
  detected: string[];
  imported: { facts: number; decisions: number; procedures: number; observations: number };
}

function makeItem(params: {
  type: MemoryType;
  state: LifecycleState;
  title: string;
  body: string;
  created: string;
  decayAfter: string;
  source: string;
  tags: string[];
  confidence?: number;
}): DraftItem {
  return {
    id: `ms_${ulid()}`,
    type: params.type,
    state: params.state,
    confidence: params.confidence ?? 0.8,
    created: params.created,
    source: params.source,
    tags: params.tags,
    decay_after: params.decayAfter,
    title: params.title,
    body: params.body,
  };
}

function sanitizeTag(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function redactIfSensitive(key: string, value: string): string {
  return /(password|token|secret|api\s*key)/i.test(key) || /(password|token|secret|api\s*key)/i.test(value)
    ? '[REDACTED]'
    : value;
}

function decayAfterFor(type: MemoryType, storeRoot: string, sourceDate?: string): string {
  const config = loadConfig(storeRoot);
  const expires = new Date(sourceDate ?? new Date().toISOString());
  expires.setUTCDate(expires.getUTCDate() + getDecayDays(config, type));
  return expires.toISOString();
}

// --- Parsers for common memory file formats ---

function parseMarkdownTable(rows: string[]): string[][] {
  return rows
    .filter((line) => /\|/.test(line))
    .slice(2) // skip header + separator
    .map((line) => line.split('|').slice(1, -1).map((cell) => (cell ?? '').trim()))
    .filter((cells) => cells.length > 0 && cells.some(Boolean));
}

function sectionTable(content: string, headingPattern: RegExp): string[] {
  const lines = content.split('\n');
  const start = lines.findIndex((line) => headingPattern.test(line.trim()));
  if (start === -1) return [];
  const rows: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) break;
    if (lines[i].trim().startsWith('|')) rows.push(lines[i]);
  }
  return rows;
}

function extractTitle(content: string, fallback: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() || fallback;
}

function importObservations(filePath: string): DraftItem[] {
  const content = readFileSync(filePath, 'utf8');
  const items: DraftItem[] = [];
  const regex = /^-\s+(?:[^\s]+\s+)?(?:\d{2}:\d{2}\s+)?(.+?)\s+<!--\s*dc:type=([a-z]+)\s+dc:importance=([0-9.]+)\s+dc:date=(\d{4}-\d{2}-\d{2})\s*-->$/gim;

  for (const match of content.matchAll(regex)) {
    const [, text, rawType, importance, date] = match;
    const type: MemoryType = rawType === 'decision' ? 'decision' : 'fact';
    items.push(makeItem({
      type,
      state: 'captured',
      title: text,
      body: text,
      created: new Date(`${date}T00:00:00Z`).toISOString(),
      decayAfter: 'never',
      source: 'brownfield-import',
      tags: ['observation', sanitizeTag(rawType)],
      confidence: Number(importance) >= 7 ? 0.85 : 0.75,
    }));
  }

  return items;
}

// --- Source-specific importers ---

/** Parse a MEMORY.md file (OpenClaw / Claude Code format) */
function importMemoryMd(filePath: string, storeRoot: string): DraftItem[] {
  const content = readFileSync(filePath, 'utf8');
  const items: DraftItem[] = [];

  // Quick Facts table
  for (const row of parseMarkdownTable(sectionTable(content, /^##\s+Quick Facts\b/i))) {
    const [entity = '', rawKey = '', rawValue = ''] = row;
    if (!entity) continue;
    const key = rawValue ? rawKey : '';
    const value = rawValue || rawKey;
    const created = new Date().toISOString();
    items.push(makeItem({
      type: 'fact',
      state: 'active',
      title: [entity, key].filter(Boolean).join(' '),
      body: redactIfSensitive(key, value),
      created,
      decayAfter: decayAfterFor('fact', storeRoot),
      source: 'brownfield-import',
      tags: [sanitizeTag(entity), sanitizeTag(key || 'fact')].filter(Boolean),
    }));
  }

  // Decisions table
  for (const [date, decision, rationale] of parseMarkdownTable(sectionTable(content, /^##\s+Decisions\b/i))) {
    if (!date || !decision) continue;
    const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : new Date().toISOString().slice(0, 10);
    const created = new Date(`${dateStr}T00:00:00Z`).toISOString();
    items.push(makeItem({
      type: 'decision',
      state: 'active',
      title: decision,
      body: rationale || decision,
      created,
      decayAfter: decayAfterFor('decision', storeRoot, created),
      source: 'brownfield-import',
      tags: ['decision'],
    }));
  }

  // Lessons section (treated as facts)
  for (const row of parseMarkdownTable(sectionTable(content, /^##\s+Lessons\b/i))) {
    const text = row.join(' — ').trim();
    if (!text) continue;
    items.push(makeItem({
      type: 'fact',
      state: 'active',
      title: text.slice(0, 80),
      body: text,
      created: new Date().toISOString(),
      decayAfter: decayAfterFor('fact', storeRoot),
      source: 'brownfield-import',
      tags: ['lesson'],
      confidence: 0.85,
    }));
  }

  return items;
}

/** Import standalone markdown files from a memory directory */
function importMemoryDir(dirPath: string, storeRoot: string): DraftItem[] {
  if (!existsSync(dirPath)) return [];
  const items: DraftItem[] = [];

  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    if (entry.name === 'README.md') continue;

    const filePath = join(dirPath, entry.name);
    if (entry.name === 'observations.md') {
      items.push(...importObservations(filePath));
      continue;
    }

    const content = readFileSync(filePath, 'utf8');
    const name = entry.name.replace(/\.md$/, '');

    // Check if file has frontmatter with type info
    const parsed = matter(content);
    const fmType = parsed.data?.type as string | undefined;

    const isDaily = /^\d{4}-\d{2}-\d{2}$/.test(name);
    // Procedure directory detection
    const isProcedure = dirPath.includes('procedures') || fmType === 'procedure';
    // Decision files
    const isDecision = fmType === 'decision' || /decision/i.test(name);

    let type: MemoryType;
    let state: LifecycleState;
    if (isDaily) {
      // Daily logs are too noisy for bulk import.
      continue;
    } else if (isProcedure) {
      type = 'procedure';
      state = 'active';
    } else if (isDecision) {
      type = 'decision';
      state = 'active';
    } else {
      type = 'fact';
      state = 'active';
    }

    const title = extractTitle(parsed.content, name);
    items.push(makeItem({
      type,
      state,
      title,
      body: parsed.content.trim(),
      created: new Date().toISOString(),
      decayAfter: decayAfterFor(type, storeRoot),
      source: 'brownfield-import',
      tags: [sanitizeTag(name)],
    }));
  }

  // Check for procedures subdirectory
  const proceduresDir = join(dirPath, 'procedures');
  if (existsSync(proceduresDir)) {
    for (const entry of readdirSync(proceduresDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name === 'README.md') continue;
      const content = readFileSync(join(proceduresDir, entry.name), 'utf8');
      const name = entry.name.replace(/\.md$/, '');
      items.push(makeItem({
        type: 'procedure',
        state: 'active',
        title: extractTitle(content, name),
        body: content.trim(),
        created: new Date().toISOString(),
        decayAfter: decayAfterFor('procedure', storeRoot),
        source: 'brownfield-import',
        tags: ['procedure', sanitizeTag(name)].filter(Boolean),
      }));
    }
  }

  return items;
}

/** Import .claude/memory/*.md (Claude Code native format) */
function importClaudeMemory(projectRoot: string, storeRoot: string): DraftItem[] {
  const claudeDir = join(projectRoot, '.claude', 'memory');
  if (!existsSync(claudeDir)) return [];
  return importMemoryDir(claudeDir, storeRoot);
}

// --- Main brownfield detection ---

export function detectBrownfieldSources(projectRoot: string): string[] {
  const sources: string[] = [];

  if (existsSync(join(projectRoot, 'MEMORY.md'))) sources.push('MEMORY.md');
  if (existsSync(join(projectRoot, 'memory'))) sources.push('memory/');
  if (existsSync(join(projectRoot, '.claude', 'memory'))) sources.push('.claude/memory/');

  // Check CLAUDE.md for memory-related sections
  const claudeMd = join(projectRoot, 'CLAUDE.md');
  if (existsSync(claudeMd)) {
    const content = readFileSync(claudeMd, 'utf8');
    if (/##\s+(memory|facts|decisions)/i.test(content)) {
      sources.push('CLAUDE.md (memory sections)');
    }
  }

  // Check AGENTS.md for memory-related sections
  const agentsMd = join(projectRoot, 'AGENTS.md');
  if (existsSync(agentsMd)) {
    const content = readFileSync(agentsMd, 'utf8');
    if (/##\s+(memory|facts|decisions)/i.test(content)) {
      sources.push('AGENTS.md (memory sections)');
    }
  }

  return sources;
}

export function importBrownfield(projectRoot: string, store: MemspecStore): BrownfieldResult {
  const detected = detectBrownfieldSources(projectRoot);
  const allItems: DraftItem[] = [];

  // MEMORY.md (structured tables)
  const memoryMdPath = join(projectRoot, 'MEMORY.md');
  if (existsSync(memoryMdPath)) {
    allItems.push(...importMemoryMd(memoryMdPath, store.root));
  }

  // memory/ directory (standalone files + procedures)
  const memoryDir = join(projectRoot, 'memory');
  if (existsSync(memoryDir)) {
    allItems.push(...importMemoryDir(memoryDir, store.root));
  }

  // .claude/memory/ (Claude Code native)
  allItems.push(...importClaudeMemory(projectRoot, store.root));

  // Write all items
  for (const item of allItems) {
    store.writeItem(item);
  }

  return {
    detected,
    imported: {
      facts: allItems.filter((i) => i.type === 'fact' && i.state === 'active').length,
      decisions: allItems.filter((i) => i.type === 'decision' && i.state === 'active').length,
      procedures: allItems.filter((i) => i.type === 'procedure' && i.state === 'active').length,
      observations: allItems.filter((i) => i.state === 'captured').length,
    },
  };
}
