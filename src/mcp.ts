#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { runAnchor } from './commands/anchor.js';
import { runObserve } from './commands/observe.js';
import { runReconcile } from './commands/reconcile.js';
import { runRemember } from './commands/remember.js';
import { searchPayload, type SearchResult } from './commands/search.js';
import { buildStatusReport, runStatus } from './commands/status.js';
import { runSupersede } from './commands/supersede.js';
import { runVerify } from './commands/verify.js';
import { homedir } from 'node:os';
import { buildLineage } from './lib/lineage.js';
import { MemspecStore } from './lib/store.js';

const { values } = parseArgs({
  options: { cwd: { type: 'string' } },
  allowPositionals: false,
  strict: false,
});

const defaultCwd = typeof values.cwd === 'string' ? values.cwd : process.env.MEMSPEC_ROOT ?? undefined;

const server = new McpServer({
  name: 'memspec',
  version: '0.3.0',
});

function renderSearchText(payload: { query: string; results: SearchResult[] }): string {
  if (payload.results.length === 0) return `No results for "${payload.query}"`;
  const lines: string[] = [`${payload.results.length} result(s) for "${payload.query}"`, ''];
  for (const item of payload.results) {
    const conflictTag = item.conflicts_with.length > 0 ? ` [CONFLICTS WITH ${item.conflicts_with.join(', ')}]` : '';
    lines.push(`[${item.type}] ${item.title} (${item.verified_with})${item.stale ? ' [STALE — verify or supersede before relying on this]' : ''}${conflictTag}`);
    lines.push(`  ${item.id} | ${item.created.substring(0, 10)} | ${item.source}`);
    if (item.tags.length > 0) lines.push(`  tags: ${item.tags.join(', ')}`);
    if (item.body !== undefined) {
      lines.push(`  ${item.body.split('\n').filter((l) => !l.startsWith('#')).join(' ').trim()}`);
    } else if (item.preview) {
      lines.push(`  ${item.preview.slice(0, 120)}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// --- Tools (v0.3 surface — 9 tools) ---

server.tool(
  'memspec_search',
  'Search project memory before answering questions or starting work. Call this at the start of every task to load relevant context. Returns ranked memories (facts, decisions, procedures) matching the query. Pass full=true to receive full bodies inline (capped at a 2000-token budget across the result set).',
  {
    query: z.string().describe('Search terms'),
    type: z.enum(['fact', 'decision', 'procedure']).optional().describe('Filter by memory type'),
    limit: z.number().min(1).max(50).optional().describe('Max results (default 10)'),
    profile: z.string().optional().describe('Retrieval profile name from config'),
    full: z.boolean().optional().describe('Include each result body inline (token-budgeted). Defaults to previews only.'),
  },
  async ({ query, type, limit, profile, full }) => {
    try {
      const payload = searchPayload(query, {
        cwd: defaultCwd,
        type,
        limit: limit?.toString(),
        profile,
        full,
      });

      return {
        content: [{ type: 'text' as const, text: renderSearchText(payload) }],
        structuredContent: {
          query: payload.query,
          profile: payload.profile,
          count: payload.count,
          full: payload.full,
          results: payload.results,
        },
      };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: String(err) }], isError: true };
    }
  },
);

server.tool(
  'memspec_get',
  'Retrieve the full content of a specific memory by ID, plus its lineage chain (what it supersedes, and what superseded it). Use after memspec_search when you need the complete body of a result or want to trace the history of a knowledge claim.',
  {
    id: z.string().describe('Memory item ID (e.g. ms_01JR...)'),
  },
  async ({ id }) => {
    try {
      const store = new MemspecStore(defaultCwd);
      const allItems = store.loadAll();
      const item = allItems.find((i) => i.id === id) ?? null;
      if (!item) {
        return { content: [{ type: 'text' as const, text: `No memory found with id: ${id}` }], isError: true };
      }
      const lineage = buildLineage(item, allItems);
      const payload = {
        id: item.id,
        kind: item.kind,
        type: item.type,
        state: item.state,
        title: item.title,
        verified_with: item.verified_with ?? 'assertion',
        created: item.created,
        source: item.source,
        source_kind: item.source_kind,
        tags: item.tags,
        check_by: item.check_by,
        last_verified: item.last_verified ?? item.created,
        anchors: item.anchors,
        supersedes: item.supersedes,
        superseded_by: item.superseded_by,
        supersede_reason: item.supersede_reason,
        lineage,
        ext: item.ext,
        body: item.body,
      };
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(payload, null, 2),
        }],
        structuredContent: payload,
      };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: String(err) }], isError: true };
    }
  },
);

interface RememberArgs {
  type: 'fact' | 'decision' | 'procedure';
  title: string;
  body?: string;
  source?: string;
  tags?: string[];
  anchors?: string[];
  check_by?: string;
  store?: string;
}

async function handleRemember({ type, title, body, source, tags, anchors, check_by, store: storeName }: RememberArgs) {
  try {
    const cwd = storeName === 'global' ? homedir() : defaultCwd;
    const resolvedSource = source ?? server.server.getClientVersion()?.name;
    const result = runRemember(type, title, {
      cwd,
      body,
      source: resolvedSource,
      tags: tags?.join(','),
      checkBy: check_by,
      anchors,
      store: storeName,
    });

    let text = result.message;
    if (result.duplicates && result.duplicates.length > 0) {
      const titles = result.duplicates.map((d) => d.title).join(', ');
      text += `\n⚠ Potential duplicates found: ${titles}. Consider memspec_supersede instead.`;
    }

    return {
      content: [{ type: 'text' as const, text }],
      structuredContent: {
        id: result.id,
        type,
        title,
        source: resolvedSource ?? null,
        tags: tags ?? [],
        check_by: check_by ?? null,
        anchors: result.anchors,
        verified_with: result.verified_with,
        anchor_warnings: result.anchorWarnings,
        duplicates: result.duplicates ?? null,
      } as Record<string, unknown>,
    };
  } catch (err) {
    return { content: [{ type: 'text' as const, text: String(err) }], isError: true };
  }
}

server.tool(
  'memspec_remember',
  'Record new project knowledge. Call this when you learn something worth remembering: a fact about architecture/config, a decision with rationale, or a reusable procedure. If this claim describes code, anchor it now via the anchors field — the anchor is the strongest available witness. Search first to avoid duplicates.',
  {
    type: z.enum(['fact', 'decision', 'procedure']).describe('Memory type'),
    title: z.string().describe('Short title for the memory'),
    body: z.string().optional().describe('Full content/details'),
    source: z.string().optional().describe('Who/what created this memory (defaults to the connected client name; "unknown" is rejected)'),
    tags: z.array(z.string()).optional().describe('Tags'),
    anchors: z.array(z.string()).optional().describe('Project-root-relative file paths to anchor the claim to. If the claim describes code, anchor it now.'),
    check_by: z.string().optional().describe('ISO timestamp or "never" — overrides the type default TTL'),
    store: z.string().optional().describe('Target store layer name (e.g., "global" for cross-project memory)'),
  },
  handleRemember,
);

interface SupersedeArgs {
  id: string;
  reason: string;
  title?: string;
  body?: string;
  merge_from?: string[];
  override_operator?: boolean;
  source?: string;
}

async function handleSupersede({ id, reason, title, body, merge_from, override_operator, source }: SupersedeArgs) {
  try {
    const result = runSupersede(id, {
      cwd: defaultCwd,
      reason,
      title,
      body,
      mergeFrom: merge_from,
      overrideOperator: override_operator,
      source,
    });
    return {
      content: [{ type: 'text' as const, text: result.message }],
      structuredContent: {
        survivor_id: result.survivor_id,
        superseded_ids: result.superseded_ids,
        reason: result.reason,
        source: source ?? null,
      } as Record<string, unknown>,
    };
  } catch (err) {
    return { content: [{ type: 'text' as const, text: String(err) }], isError: true };
  }
}

server.tool(
  'memspec_supersede',
  'Replace, retract, or merge memory. Body filled = replacement (new active record supersedes the old). Body empty = retraction. merge_from collapses N duplicates into one survivor atomically (use to consolidate near-duplicates surfaced by status). Reason is persisted durably on every record involved.',
  {
    id: z.string().describe('Memory ID to supersede (or the survivor id when merging without a replacement body)'),
    reason: z.string().describe('Why the target is wrong, stale, or being merged. Persisted on every record involved.'),
    title: z.string().optional().describe('Fresh title for the replacement (only used when body is provided; defaults to the old title)'),
    body: z.string().optional().describe('Replacement content. If omitted with no merge_from, the target is retracted.'),
    merge_from: z.array(z.string()).optional().describe('Additional memory ids to collapse into the survivor in a single atomic operation.'),
    override_operator: z.boolean().optional().describe('Required to supersede operator-sourced records; logged into the persisted reason.'),
    source: z.string().optional().describe('Who is performing the supersede'),
  },
  handleSupersede,
);

server.tool(
  'memspec_observe',
  'Capture a point-in-time observation with hard expiry. Observations index a moment — they do not go stale and do not claim to be current; they simply vanish on expiry. Use for ephemeral context (what a tool returned, what was visible on screen, what a user said in passing). For durable knowledge, use memspec_remember instead.',
  {
    text: z.string().describe('Observation text. First line becomes the title; the full text is the body.'),
    ttl: z.string().optional().describe('Duration before the observation expires (e.g. "7d", "48h", "never"). Defaults to 7d.'),
  },
  async ({ text, ttl }) => {
    try {
      const resolvedSource = server.server.getClientVersion()?.name ?? 'agent';
      const result = runObserve({ cwd: defaultCwd, text, ttl, source: resolvedSource });
      return {
        content: [{ type: 'text' as const, text: result.message }],
        structuredContent: {
          id: result.id,
          expires: result.expires,
          source: resolvedSource,
        },
      };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: String(err) }], isError: true };
    }
  },
);

server.tool(
  'memspec_verify',
  'Record that a memory is still true as of now. Anchored memories: each anchored file is checked against its recorded blob SHA — drifted anchors return needs_review without touching the memory. Anchorless memories: evidence text required (state what you checked). Clean verification refreshes last_verified, clears the stale flag, and resets the check_by clock.',
  {
    id: z.string().describe('Memory ID to verify'),
    evidence: z.string().optional().describe('What you checked to confirm this is still true — required when the memory has no code anchors'),
    source: z.string().optional().describe('Who is verifying'),
  },
  async ({ id, evidence, source }) => {
    try {
      const result = runVerify(id, { cwd: defaultCwd, evidence, source });
      return {
        content: [{ type: 'text' as const, text: result.message }],
        structuredContent: {
          id: result.id,
          status: result.status,
          last_verified: result.last_verified,
          verified_with: result.verified_with,
          anchors: result.anchors,
        },
      };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: String(err) }], isError: true };
    }
  },
);

server.tool(
  'memspec_anchor',
  'Link a memory to the source files it depends on. Records the git blob SHA of each file so verify/reconcile can detect when the code a memory describes has changed. Anchoring also asserts the memory is true against the current file state.',
  {
    id: z.string().describe('Memory ID to anchor'),
    files: z.array(z.string()).min(1).describe('File paths relative to the project root'),
    replace: z.boolean().optional().describe('Replace existing anchors instead of merging'),
    source: z.string().optional().describe('Who is anchoring'),
  },
  async ({ id, files, replace, source }) => {
    try {
      const result = runAnchor(id, files, { cwd: defaultCwd, replace, source });
      return {
        content: [{ type: 'text' as const, text: result.message }],
        structuredContent: {
          id: result.id,
          anchors: result.anchors,
          warnings: result.warnings,
        },
      };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: String(err) }], isError: true };
    }
  },
);

server.tool(
  'memspec_reconcile',
  'Find anchored memories whose code has drifted. Compares each active memory\'s code anchors against current file content and reports candidates for review (verify, supersede, or re-anchor). Run after landing commits that change system behavior.',
  {
    since_ref: z.string().optional().describe('Git ref to diff from (default: last reconcile checkpoint, fallback HEAD~10)'),
  },
  async ({ since_ref }) => {
    try {
      const result = runReconcile({ cwd: defaultCwd, since: since_ref });
      return {
        content: [{ type: 'text' as const, text: result.message }],
        structuredContent: {
          reconciled_at: result.reconciled_at,
          since_ref: result.since_ref,
          head: result.head,
          anchored_memories: result.anchored_memories,
          count: result.candidates.length,
          candidates: result.candidates,
        },
      };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: String(err) }], isError: true };
    }
  },
);

server.tool(
  'memspec_status',
  'Check memory store health. Counts by type/state/witness, stale flags, drifted anchors, declared and inferred conflicts, schema violations, and sweep candidates. Use when unsure if the store is populated or healthy, or after running migrations.',
  {},
  async () => {
    try {
      const { report } = buildStatusReport({ cwd: defaultCwd });
      const text = runStatus({ cwd: defaultCwd });
      return {
        content: [{ type: 'text' as const, text }],
        structuredContent: report as unknown as Record<string, unknown>,
      };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: String(err) }], isError: true };
    }
  },
);

// --- Deprecation shims (v0.2 names; removed in v0.4) ---
//
// Real v0.2 installs exist on npm. The renamed primitives keep answering
// under their old names for one minor version, marked deprecated in every
// response. Deleted tools (promote, consolidate, validate, decay, init,
// stores) have no successor and get no shim.

type ToolResult = Awaited<ReturnType<typeof handleRemember>>;

function markDeprecated(result: ToolResult, oldName: string, newName: string): ToolResult {
  // console.warn goes to stderr — stdout belongs to the stdio transport.
  console.warn(`[memspec] ${oldName} is deprecated; use ${newName}. The alias will be removed in v0.4.`);
  const deprecation = `use ${newName}; will be removed in v0.4`;
  if (result.structuredContent) {
    result.structuredContent._deprecated = deprecation;
  }
  result.content = [
    ...result.content,
    { type: 'text' as const, text: `⚠ DEPRECATED: ${oldName} — ${deprecation}.` },
  ];
  return result;
}

server.tool(
  'memspec_add',
  'DEPRECATED — renamed to memspec_remember in v0.3; this alias will be removed in v0.4. Records new project knowledge.',
  {
    type: z.enum(['fact', 'decision', 'procedure']).describe('Memory type'),
    title: z.string().describe('Short title for the memory'),
    body: z.string().optional().describe('Full content/details'),
    source: z.string().optional().describe('Who/what created this memory (defaults to the connected client name; "unknown" is rejected)'),
    tags: z.string().optional().describe('Comma-separated tags'),
    decay_after: z.string().optional().describe('ISO timestamp or "never" (maps to check_by)'),
    store: z.string().optional().describe('Target store layer name (e.g., "global" for cross-project memory)'),
  },
  async ({ type, title, body, source, tags, decay_after, store: storeName }) => {
    const result = await handleRemember({
      type,
      title,
      body,
      source,
      tags: tags ? tags.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
      check_by: decay_after,
      store: storeName,
    });
    return markDeprecated(result, 'memspec_add', 'memspec_remember');
  },
);

server.tool(
  'memspec_correct',
  'DEPRECATED — renamed to memspec_supersede in v0.3; this alias will be removed in v0.4. Fixes wrong or stale knowledge.',
  {
    id: z.string().describe('Memory ID to correct'),
    reason: z.string().describe('Why this memory is wrong or stale'),
    replace: z.string().optional().describe('Replacement content (maps to body)'),
    title: z.string().optional().describe('Fresh title for the replacement (defaults to the old title)'),
    supersede_by: z.string().optional().describe('Mark this memory as corrected by an existing memory ID (maps to a merge into that survivor)'),
    override_operator: z.boolean().optional().describe('Required to correct operator-sourced records; logged into the persisted reason'),
    source: z.string().optional().describe('Who is making the correction'),
  },
  async ({ id, reason, replace, title, supersede_by, override_operator, source }) => {
    // v0.2 supersede_by = "an existing record replaces this one" — in v0.3
    // terms that's a merge with the existing record as survivor.
    const result = supersede_by
      ? await handleSupersede({ id: supersede_by, reason, merge_from: [id], override_operator, source })
      : await handleSupersede({ id, reason, title, body: replace, override_operator, source });
    return markDeprecated(result, 'memspec_correct', 'memspec_supersede');
  },
);

// --- Start ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`memspec MCP server error: ${err}\n`);
  process.exit(1);
});
