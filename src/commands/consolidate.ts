import { MemspecStore } from '../lib/store.js';
import { MEMORY_TYPES, type MemoryType } from '../lib/types.js';

export interface ConsolidateOptions {
  cwd?: string;
  type?: string;
  json?: boolean;
}

export interface DuplicateGroupItem {
  id: string;
  title: string;
  created: string;
  confidence: number;
}

export interface DuplicateGroup {
  items: DuplicateGroupItem[];
  similarity: 'high' | 'medium';
}

export interface ConsolidateResult {
  groups: DuplicateGroup[];
  message: string;
}

function assertMemoryType(input: string): MemoryType {
  if ((MEMORY_TYPES as readonly string[]).includes(input)) {
    return input as MemoryType;
  }
  throw new Error(`Unsupported memory type: ${input}`);
}

export function runConsolidate(options: ConsolidateOptions): ConsolidateResult {
  const store = new MemspecStore(options.cwd);
  const activeItems = store.loadActive();

  const typeFilter = options.type ? assertMemoryType(options.type) : undefined;
  const items = typeFilter
    ? activeItems.filter((item) => item.type === typeFilter)
    : activeItems;

  if (items.length < 2) {
    return { groups: [], message: 'Not enough items to check for duplicates.' };
  }

  // Track which item IDs have already been placed in a group
  const grouped = new Set<string>();
  const groups: DuplicateGroup[] = [];

  for (const item of items) {
    if (grouped.has(item.id)) continue;

    // Search for similar items using the item's title as query
    const matches = store.search(item.title, {
      types: [item.type],
      limit: 6, // get extra to account for self-match
    });

    // Exclude self from matches
    const others = matches.filter((m) => m.id !== item.id && !grouped.has(m.id));

    if (others.length === 0) continue;

    // Build a group: the current item + matching items
    const groupItems: DuplicateGroupItem[] = [
      { id: item.id, title: item.title, created: item.created, confidence: item.confidence },
    ];

    for (const other of others) {
      groupItems.push({
        id: other.id,
        title: other.title,
        created: other.created,
        confidence: other.confidence,
      });
    }

    // Mark all items in this group as grouped
    for (const gi of groupItems) {
      grouped.add(gi.id);
    }

    // Classify similarity based on group size
    const similarity: 'high' | 'medium' = groupItems.length >= 3 ? 'high' : 'medium';

    groups.push({ items: groupItems, similarity });
  }

  // Sort by group size descending (largest groups first)
  groups.sort((a, b) => b.items.length - a.items.length);

  if (groups.length === 0) {
    return { groups: [], message: 'No potential duplicates found.' };
  }

  if (options.json) {
    return {
      groups,
      message: JSON.stringify({ groups, count: groups.length }, null, 2),
    };
  }

  const lines: string[] = [`Found ${groups.length} group(s) of potential duplicates:`, ''];

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    lines.push(`Group ${i + 1} (${group.similarity} similarity):`);
    for (const gi of group.items) {
      lines.push(`  - [${gi.id}] ${gi.title} (confidence: ${gi.confidence.toFixed(2)}, created: ${gi.created.substring(0, 10)})`);
    }
    lines.push('');
  }

  lines.push('Use memspec correct to merge or deduplicate these items.');

  return { groups, message: lines.join('\n') };
}
