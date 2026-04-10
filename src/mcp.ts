#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { runAdd } from './commands/add.js';
import { runCorrect } from './commands/correct.js';
import { runPromote } from './commands/promote.js';
import { runDecay } from './commands/decay.js';
import { runSearch } from './commands/search.js';
import { runStatus } from './commands/status.js';
import { runValidate } from './commands/validate.js';
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
    source: z.string().optional().describe('Who/what created this memory'),
    tags: z.string().optional().describe('Comma-separated tags'),
    decay_after: z.string().optional().describe('ISO timestamp or "never"'),
    store: z.string().optional().describe('Target store layer name (e.g., "global" for cross-project memory)'),
  },
  async ({ type, title, body, source, tags, decay_after, store: storeName }) => {
    try {
      const cwd = storeName === 'global' ? homedir() : defaultCwd;
      const result = runAdd(type, title, {
        cwd,
        body,
        source,
        tags,
        decayAfter: decay_after,
        store: storeName,
      });
      return {
        content: [{ type: 'text' as const, text: result }],
        structuredContent: {
          type,
          title,
          source: source ?? 'unknown',
          tags: tags?.split(',').map((tag) => tag.trim()).filter(Boolean) ?? [],
          decay_after: decay_after ?? null,
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
  'memspec_correct',
  'Fix wrong or stale knowledge. When you discover an existing memory is outdated or incorrect, correct it rather than adding a conflicting duplicate. Optionally provide replacement content.',
  {
    id: z.string().describe('Memory ID to correct'),
    reason: z.string().describe('Why this memory is wrong or stale'),
    replace: z.string().optional().describe('Replacement content (creates new memory)'),
    source: z.string().optional().describe('Who is making the correction'),
  },
  async ({ id, reason, replace, source }) => {
    try {
      const result = runCorrect(id, { cwd: defaultCwd, reason, replace, source });
      return {
        content: [{ type: 'text' as const, text: result }],
        structuredContent: {
          id,
          reason,
          replace: replace ?? null,
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
  'memspec_init',
  'Initialize a memspec store in a project. Creates .memspec/, detects and imports existing memory files (MEMORY.md, memory/, .claude/memory/), and patches AGENTS.md/CLAUDE.md with agent instructions.',
  {
    search_engine: z.enum(['fts5', 'hybrid']).optional().describe('Search engine (default fts5)'),
    embeddings_provider: z.string().optional().describe('openai or ollama'),
    embeddings_endpoint: z.string().optional().describe('Embedding endpoint URL'),
    embeddings_model: z.string().optional().describe('Embedding model name'),
    embeddings_api_key: z.string().optional().describe('Embedding API key'),
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
