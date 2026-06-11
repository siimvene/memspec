#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { runAnchor } from './commands/anchor.js';
import { runObserve } from './commands/observe.js';
import { runReconcile } from './commands/reconcile.js';
import { runRemember } from './commands/remember.js';
import { runSearch } from './commands/search.js';
import { buildStatusReport, runStatus } from './commands/status.js';
import { runSupersede } from './commands/supersede.js';
import { runVerify } from './commands/verify.js';
import { homedir } from 'node:os';
import { loadConfig, getProfile } from './lib/config.js';
import { buildLineage } from './lib/lineage.js';
import { MemspecStore } from './lib/store.js';
import { MEMORY_TYPES, type MemoryType } from './lib/types.js';

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

function previewFromBody(body: string): string {
  const lines = body.split('\n').filter((line) => !line.startsWith('#'));
  return lines.join(' ').trim().slice(0, 160);
}

function resolveSearchType(type?: string): MemoryType[] | undefined {
  if (!type) return undefined;
  if ((MEMORY_TYPES as readonly string[]).includes(type)) {
    return [type as MemoryType];
  }
  return undefined;
}

// --- Tools (v0.3 surface — 9 tools) ---

server.tool(
  'memspec_search',
  'Search project memory before answering questions or starting work. Call this at the start of every task to load relevant context. Returns ranked memories (facts, decisions, procedures) matching the query.',
  {
    query: z.string().describe('Search terms'),
    type: z.enum(['fact', 'decision', 'procedure']).optional().describe('Filter by memory type'),
    limit: z.number().min(1).max(50).optional().describe('Max results (default 10)'),
    profile: z.string().optional().describe('Retrieval profile name from config'),
  },
  async ({ query, type, limit, profile }) => {
    try {
      const store = new MemspecStore(defaultCwd);
      const config = loadConfig(store.root);
      const profileName = profile ?? 'default';
      const retrieval = getProfile(config, profileName);
      const results = store.search(query, {
        limit: limit ?? 10,
        types: resolveSearchType(type) ??
          retrieval.types?.filter((item): item is MemoryType => (MEMORY_TYPES as readonly string[]).includes(item)),
        minConfidence: retrieval.min_confidence ?? 0,
        ranking: retrieval.ranking,
      });

      const payload = results.map((item) => ({
        id: item.id,
        type: item.type,
        title: item.title,
        verified_with: item.verified_with ?? 'assertion',
        created: item.created,
        last_verified: item.last_verified ?? item.created,
        source: item.source,
        tags: item.tags,
        stale: item.stale ?? false,
        preview: previewFromBody(item.body),
      }));

      const result = runSearch(query, {
        cwd: defaultCwd,
        type,
        limit: limit?.toString(),
        profile,
        json: true,
      });

      return {
        content: [{ type: 'text' as const, text: result }],
        structuredContent: {
          query,
          profile: profileName,
          count: payload.length,
          results: payload,
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
  async ({ type, title, body, source, tags, anchors, check_by, store: storeName }) => {
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
        },
      };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: String(err) }], isError: true };
    }
  },
);

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
  async ({ id, reason, title, body, merge_from, override_operator, source }) => {
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
        },
      };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: String(err) }], isError: true };
    }
  },
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

// --- Start ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`memspec MCP server error: ${err}\n`);
  process.exit(1);
});
