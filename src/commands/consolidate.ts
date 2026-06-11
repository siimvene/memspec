import { buildStatusReport } from './status.js';

export interface ConsolidateOptions {
  cwd?: string;
  type?: string;
  json?: boolean;
}

export interface DuplicateGroupItem {
  id: string;
  title: string;
  created: string;
  verified_with: string;
}

export interface DuplicateGroup {
  items: DuplicateGroupItem[];
  similarity: 'high' | 'medium';
}

export interface ConsolidateResult {
  groups: DuplicateGroup[];
  message: string;
}

/**
 * Deprecated in v0.3. The duplicate-detection job moved into `memspec status`
 * (conflict report), and the merge primitive moved into `memspec supersede
 * --merge-from`. This CLI shim points callers at the new surface; the MCP
 * tool has been removed.
 */
export function runConsolidate(options: ConsolidateOptions): ConsolidateResult {
  const { report } = buildStatusReport(options);

  const lines = [
    'memspec consolidate is deprecated in v0.3.',
    '  Duplicate detection: `memspec status` (conflict section).',
    '  Merging: `memspec supersede <survivor> --reason "..." --merge-from <dup1>,<dup2>`.',
    '',
  ];

  if (report.conflicts.length === 0) {
    lines.push('No potential duplicates found.');
    return { groups: [], message: lines.join('\n') };
  }

  lines.push(`${report.conflicts.length} conflict(s) detected:`);
  for (const c of report.conflicts) {
    lines.push(`  [${c.reason}] ${c.a.id} ↔ ${c.b.id}`);
    lines.push(`    ${c.a.title}`);
    lines.push(`    ${c.b.title}`);
  }

  return { groups: [], message: lines.join('\n') };
}
