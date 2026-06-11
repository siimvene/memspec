import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { getDecayDays, loadConfig } from './config.js';
import { MemspecStore } from './store.js';
import type { LifecycleState, MemoryFrontmatter, MemoryType } from './types.js';

export interface ImportOpenClawOptions {
  cwd?: string;
  source: string;
}

interface DraftMemoryItem extends MemoryFrontmatter {
  title: string;
  body: string;
}

export interface ImportSummary {
  facts: number;
  decisions: number;
  procedures: number;
  observations: number;
}

export function looksLikeOpenClawWorkspace(sourceRoot: string): boolean {
  return (
    existsSync(join(sourceRoot, 'MEMORY.md')) ||
    existsSync(join(sourceRoot, 'memory', 'observations.md')) ||
    existsSync(join(sourceRoot, 'memory', 'procedures'))
  );
}

const OBSERVATION_TYPE_MAP: Record<string, MemoryType> = {
  decision: 'decision',
  fact: 'fact',
  context: 'fact',
  event: 'fact',
  goal: 'fact',
  habit: 'fact',
  lesson: 'fact',
  preference: 'fact',
  rule: 'fact',
};

function sectionTable(content: string, headingPattern: RegExp): string[] {
  const lines = content.split('\n');
  const start = lines.findIndex((line) => headingPattern.test(line.trim()));
  if (start === -1) return [];

  const rows: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith('## ')) break;
    if (line.trim().startsWith('|')) rows.push(line);
  }
  return rows;
}

function parseMarkdownTable(rows: string[]): string[][] {
  return rows
    .filter((line) => /\|/.test(line))
    .slice(2)
    .map((line) => line.split('|').slice(1, -1).map((cell) => (cell ?? '').trim()))
    .filter((cells) => cells.length > 0 && cells.some(Boolean));
}

function sanitizeTag(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function redactIfSensitive(key: string, value: string): string {
  const sensitiveKey = /(password|token|secret|api\s*key)/i.test(key);
  const sensitiveValue = /(password|token|secret|api\s*key)/i.test(value);
  return sensitiveKey || sensitiveValue ? '[REDACTED]' : value;
}

function makeItem(params: {
  type: MemoryType;
  state: LifecycleState;
  title: string;
  body: string;
  created: string;
  check_by: string;
  source: string;
  tags: string[];
  ext?: Record<string, unknown>;
}): DraftMemoryItem {
  return {
    id: `ms_${ulid()}`,
    kind: 'claim',
    type: params.type,
    state: params.state,
    created: params.created,
    source: params.source,
    tags: params.tags,
    check_by: params.check_by,
    ext: params.ext,
    title: params.title,
    body: params.body,
  };
}

function checkByFor(type: MemoryType, sourceDate: string, storeRoot: string): string {
  const config = loadConfig(storeRoot);
  const expires = new Date(sourceDate);
  expires.setUTCDate(expires.getUTCDate() + getDecayDays(config, type));
  return expires.toISOString();
}

function importMemoryMd(sourceRoot: string, store: MemspecStore): DraftMemoryItem[] {
  const filePath = join(sourceRoot, 'MEMORY.md');
  if (!existsSync(filePath)) return [];

  const content = readFileSync(filePath, 'utf8');
  const items: DraftMemoryItem[] = [];

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
      check_by: checkByFor('fact', created, store.root),
      source: 'openclaw-import',
      tags: [sanitizeTag(entity), sanitizeTag(key || 'fact')].filter(Boolean),
    }));
  }

  for (const [date, decision, rationale] of parseMarkdownTable(sectionTable(content, /^##\s+Decisions\b/i))) {
    const created = new Date(`${date}T00:00:00Z`).toISOString();
    items.push(makeItem({
      type: 'decision',
      state: 'active',
      title: decision,
      body: rationale,
      created,
      check_by: checkByFor('decision', created, store.root),
      source: 'openclaw-import',
      tags: ['decision'],
    }));
  }

  return items;
}

function extractTitle(content: string, fallback: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() || fallback;
}

function importProcedures(sourceRoot: string, store: MemspecStore): DraftMemoryItem[] {
  const proceduresDir = join(sourceRoot, 'memory', 'procedures');
  if (!existsSync(proceduresDir)) return [];

  const items: DraftMemoryItem[] = [];
  for (const entry of readdirSync(proceduresDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name === 'README.md') continue;

    const content = readFileSync(join(proceduresDir, entry.name), 'utf8');
    const created = new Date().toISOString();
    items.push(makeItem({
      type: 'procedure',
      state: 'active',
      title: extractTitle(content, entry.name.replace(/\.md$/, '')),
      body: content,
      created,
      check_by: checkByFor('procedure', created, store.root),
      source: 'openclaw-import',
      tags: ['procedure', sanitizeTag(entry.name.replace(/\.md$/, ''))].filter(Boolean),
    }));
  }

  return items;
}

function importObservations(sourceRoot: string): DraftMemoryItem[] {
  const filePath = join(sourceRoot, 'memory', 'observations.md');
  if (!existsSync(filePath)) return [];

  const content = readFileSync(filePath, 'utf8');
  const items: DraftMemoryItem[] = [];
  const regex = /^-\s+(?:[^\s]+\s+)?(?:\d{2}:\d{2}\s+)?(.+?)\s+<!--\s*dc:type=([a-z]+)\s+dc:importance=([0-9.]+)\s+dc:date=(\d{4}-\d{2}-\d{2})\s*-->$/gim;

  for (const match of content.matchAll(regex)) {
    const [, text, rawType, importance, date] = match;
    const mappedType = OBSERVATION_TYPE_MAP[rawType] ?? 'fact';
    items.push(makeItem({
      type: mappedType,
      state: 'active',
      title: text,
      body: text,
      created: new Date(`${date}T00:00:00Z`).toISOString(),
      check_by: 'never',
      source: 'openclaw-import',
      tags: ['observation', rawType],
      ext: {
        importance: Number(importance),
        openclaw_type: rawType,
      },
    }));
  }

  return items;
}

export function importOpenClawWorkspace(store: MemspecStore, sourceRoot: string): ImportSummary {
  const imported = [
    ...importMemoryMd(sourceRoot, store),
    ...importProcedures(sourceRoot, store),
    ...importObservations(sourceRoot),
  ];

  for (const item of imported) {
    store.writeItem(item);
  }

  return {
    facts: imported.filter((item) => item.state === 'active' && item.type === 'fact').length,
    decisions: imported.filter((item) => item.state === 'active' && item.type === 'decision').length,
    procedures: imported.filter((item) => item.state === 'active' && item.type === 'procedure').length,
    observations: 0,
  };
}

export function runImportOpenClaw(options: ImportOpenClawOptions): string {
  if (!options.source) {
    throw new Error('Missing required --source <path>');
  }

  const store = new MemspecStore(options.cwd);
  store.init();

  const summary = importOpenClawWorkspace(store, options.source);

  return [
    `Imported OpenClaw memory from ${options.source}`,
    `  facts: ${summary.facts}`,
    `  decisions: ${summary.decisions}`,
    `  procedures: ${summary.procedures}`,
    `  observations: ${summary.observations}`,
  ].join('\n');
}
