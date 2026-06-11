#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { runAdd } from './commands/add.js';
import { runAnchor } from './commands/anchor.js';
import { runConsolidate } from './commands/consolidate.js';
import { runCorrect } from './commands/correct.js';
import { runPromote } from './commands/promote.js';
import { runDecay } from './commands/decay.js';
import { runReconcile } from './commands/reconcile.js';
import { runSearch } from './commands/search.js';
import { runStatus } from './commands/status.js';
import { runValidate } from './commands/validate.js';
import { runVerify } from './commands/verify.js';
import { runInit } from './commands/init.js';
import { homedir } from 'node:os';
import { loadConfig, getProfile } from './lib/config.js';
import { MemspecStore } from './lib/store.js';
import { CompositeStore } from './lib/composite-store.js';
import { MEMORY_TYPES, type MemoryType } from './lib/types.js';

const { values } = parseArgs({
  options: { cwd: { type: 'string' } },
  allowPositionals: false,
  strict: false,
});

const defaultCwd = typeof values.cwd === 'string' ? values.cwd : process.env.MEMSPEC_ROOT ?? undefined;

const server = new McpServer({
  name: 'memspec',
  version: '0.2.0',
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

// --- Tools ---

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
        confidence: item.confidence,
        created: item.created,
        last_verified: item.last_verified ?? item.created,
        source: item.source,
        tags: item.tags,
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
  'Retrieve the full content of a specific memory by ID. Use after memspec_search when you need the complete body of a result.',
  {
    id: z.string().describe('Memory item ID (e.g. ms_01JR...)'),
  },
  async ({ id }) => {
    try {
      const store = new MemspecStore(defaultCwd);
      const item = store.findById(id);
      if (!item) {
        return { content: [{ type: 'text' as const, text: `No memory found with id: ${id}` }], isError: true };
      }
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            id: item.id,
            type: item.type,
            state: item.state,
            title: item.title,
            confidence: item.confidence,
            created: item.created,
            source: item.source,
            tags: item.tags,
            decay_after: item.decay_after,
            last_verified: item.last_verified ?? item.created,
            ext: item.ext,
            body: item.body,
          }, null, 2),
        }],
        structuredContent: {
          id: item.id,
          type: item.type,
          state: item.state,
          title: item.title,
          confidence: item.confidence,
          created: item.created,
          source: item.source,
          tags: item.tags,
          decay_after: item.decay_after,
          last_verified: item.last_verified ?? item.created,
          ext: item.ext,
          body: item.body,
        },
      };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: String(err) }], isError: true };
    }
  },
);

server.tool(
  'memspec_add',
  'Record new project knowledge. Call this when you learn something worth remembering: a fact about architecture/config, a decision with rationale, or a reusable procedure. Search first to avoid duplicates.',
  {
    type: z.enum(['fact', 'decision', 'procedure']).describe('Memory type'),
    title: z.string().describe('Short title for the memory'),
    body: z.string().optional().describe('Full content/details'),
    source: z.string().optional().describe('Who/what created this memory (defaults to the connected client name; "unknown" is rejected)'),
    tags: z.string().optional().describe('Comma-separated tags'),
    decay_after: z.string().optional().describe('ISO timestamp or "never"'),
    store: z.string().optional().describe('Target store layer name (e.g., "global" for cross-project memory)'),
  },
  async ({ type, title, body, source, tags, decay_after, store: storeName }) => {
    try {
      const cwd = storeName === 'global' ? homedir() : defaultCwd;
      const resolvedSource = source ?? server.server.getClientVersion()?.name;
      const result = runAdd(type, title, {
        cwd,
        body,
        source: resolvedSource,
        tags,
        decayAfter: decay_after,
        store: storeName,
      });

      let text = result.message;
      if (result.duplicates && result.duplicates.length > 0) {
        const titles = result.duplicates.map((d) => d.title).join(', ');
        text += `\n\u26a0 Potential duplicates found: ${titles}. Consider using memspec_correct instead.`;
      }

      return {
        content: [{ type: 'text' as const, text }],
        structuredContent: {
          type,
          title,
          source: resolvedSource ?? null,
          tags: tags?.split(',').map((tag) => tag.trim()).filter(Boolean) ?? [],
          decay_after: decay_after ?? null,
          duplicates: result.duplicates ?? null,
        },
      };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: String(err) }], isError: true };
    }
  },
);

server.tool(
  'memspec_promote',
  'Confirm or promote a captured memory. When stabilization is enabled, memories start as captured and need confirmations before becoming active. Call this when you re-encounter a previously captured observation to strengthen it.',
  {
    id: z.string().describe('Memory ID to confirm/promote'),
    source: z.string().optional().describe('Who is confirming this memory'),
  },
  async ({ id, source }) => {
    try {
      const result = runPromote(id, { cwd: defaultCwd, source });
      return {
        content: [{ type: 'text' as const, text: result }],
        structuredContent: { id, source: source ?? null, result },
      };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: String(err) }], isError: true };
    }
  },
);

server.tool(
  'memspec_verify',
  'Record that a memory is still true as of now. If the memory has code anchors, checks each anchored file against its recorded blob SHA first — drifted anchors return needs_review without touching the memory. Anchorless memories require evidence text stating what you checked. Clean verification refreshes last_verified, bumps confidence, and resets the decay clock.',
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
          confidence: result.confidence,
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
  'Link a memory to the source files it depends on. Records the git blob SHA of each file so verify/reconcile/decay can detect when the code a memory describes has changed. Anchoring also asserts the memory is true against the current file state.',
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
  'memspec_correct',
  'Fix wrong or stale knowledge. When you discover an existing memory is outdated or incorrect, correct it rather than adding a conflicting duplicate. Optionally provide replacement content.',
  {
    id: z.string().describe('Memory ID to correct'),
    reason: z.string().describe('Why this memory is wrong or stale'),
    replace: z.string().optional().describe('Replacement content (creates new memory)'),
    title: z.string().optional().describe('Fresh title for the replacement (defaults to the old title)'),
    supersede_by: z.string().optional().describe('Mark this memory as corrected by an existing memory ID instead of minting a new one (merges duplicates)'),
    override_operator: z.boolean().optional().describe('Required to correct operator-sourced records; use only with explicit cause — the override is logged into the correction reason'),
    source: z.string().optional().describe('Who is making the correction'),
  },
  async ({ id, reason, replace, title, supersede_by, override_operator, source }) => {
    try {
      const result = runCorrect(id, { cwd: defaultCwd, reason, replace, title, supersedeBy: supersede_by, overrideOperator: override_operator, source });
      return {
        content: [{ type: 'text' as const, text: result }],
        structuredContent: {
          id,
          reason,
          replace: replace ?? null,
          title: title ?? null,
          supersede_by: supersede_by ?? null,
          source: source ?? null,
        },
      };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: String(err) }], isError: true };
    }
  },
);

server.tool(
  'memspec_status',
  'Check memory store health. Shows counts by type/state, decay candidates, and recent items. Use when unsure if the store is populated or healthy.',
  {},
  async () => {
    try {
      const store = new MemspecStore(defaultCwd);
      const items = store.loadAll();
      const byType: Record<string, number> = {};
      const byState: Record<string, number> = {};

      for (const item of items) {
        byState[item.state] = (byState[item.state] ?? 0) + 1;
        if (item.state === 'active') {
          byType[item.type] = (byType[item.type] ?? 0) + 1;
        }
      }

      const result = runStatus({ cwd: defaultCwd });
      return {
        content: [{ type: 'text' as const, text: result }],
        structuredContent: {
          root: store.root,
          byType,
          byState,
          total: items.length,
          warnings: store.warnings.length,
        },
      };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: String(err) }], isError: true };
    }
  },
);

server.tool(
  'memspec_validate',
  'Validate all memory files against the memspec schema. Run before committing to catch broken frontmatter or malformed files.',
  {},
  async () => {
    try {
      const result = runValidate({ cwd: defaultCwd });
      return {
        content: [{ type: 'text' as const, text: result }],
        structuredContent: {
          valid: true,
          summary: result,
        },
      };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: String(err) }], isError: true };
    }
  },
);

server.tool(
  'memspec_decay',
  'Clean up expired memories. Facts decay after 90 days, decisions after 180. Use dry_run to preview, or archive to move expired items out of the active set.',
  {
    dry_run: z.boolean().optional().describe('Preview without changes'),
    archive: z.boolean().optional().describe('Move to archive instead of marking decayed'),
  },
  async ({ dry_run, archive }) => {
    try {
      const result = runDecay({ cwd: defaultCwd, dryRun: dry_run, archive });
      return {
        content: [{ type: 'text' as const, text: result }],
        structuredContent: {
          dry_run: dry_run ?? false,
          archive: archive ?? false,
          summary: result,
        },
      };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: String(err) }], isError: true };
    }
  },
);

server.tool(
  'memspec_reconcile',
  'Find anchored memories whose code has drifted. Compares each active memory\'s code anchors against current file content and reports candidates for review (verify, correct, or re-anchor). Run after landing commits that change system behavior.',
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
  'memspec_consolidate',
  'Find duplicate or redundant memories that should be merged. Returns groups of similar items. Use memspec_correct to merge them.',
  {
    type: z.enum(['fact', 'decision', 'procedure']).optional().describe('Filter by memory type'),
  },
  async ({ type }) => {
    try {
      const result = runConsolidate({ cwd: defaultCwd, type, json: false });
      return {
        content: [{ type: 'text' as const, text: result.message }],
        structuredContent: {
          count: result.groups.length,
          groups: result.groups,
        },
      };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: String(err) }], isError: true };
    }
  },
);

server.tool(
  'memspec_init',
  'Initialize a memspec store in a project. Creates .memspec/, detects and imports existing memory files (MEMORY.md, memory/, .claude/memory/), and patches AGENTS.md/CLAUDE.md with agent instructions.',
  {
    search_engine: z.enum(['fts5', 'hybrid']).optional().describe('Search engine (default fts5). hybrid is experimental/future and requires embeddings config'),
    embeddings_provider: z.string().optional().describe('openai or ollama (only used with hybrid search -- future feature)'),
    embeddings_endpoint: z.string().optional().describe('Embedding endpoint URL (future feature)'),
    embeddings_model: z.string().optional().describe('Embedding model name (future feature)'),
    embeddings_api_key: z.string().optional().describe('Embedding API key (future feature)'),
  },
  async ({ search_engine, embeddings_provider, embeddings_endpoint, embeddings_model, embeddings_api_key }) => {
    try {
      const result = await runInit({
        cwd: defaultCwd,
        interactive: false,
        searchEngine: search_engine,
        embeddingsProvider: embeddings_provider,
        embeddingsEndpoint: embeddings_endpoint,
        embeddingsModel: embeddings_model,
        embeddingsApiKey: embeddings_api_key,
      });
      return {
        content: [{ type: 'text' as const, text: result }],
        structuredContent: {
          cwd: defaultCwd ?? process.cwd(),
          search_engine: search_engine ?? 'fts5',
          embeddings_provider: embeddings_provider ?? null,
          embeddings_endpoint: embeddings_endpoint ?? null,
          embeddings_model: embeddings_model ?? null,
        },
      };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: String(err) }], isError: true };
    }
  },
);

server.tool(
  'memspec_stores',
  'List configured memory store layers. Shows global, project, and any custom stores with their priority, status, and item counts.',
  {},
  async () => {
    try {
      const store = new MemspecStore(defaultCwd);
      const config = loadConfig(store.root);
      const composite = CompositeStore.fromConfig(config.stores, defaultCwd);
      const layers = composite.listLayers();

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(layers, null, 2) }],
        structuredContent: { layers },
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
