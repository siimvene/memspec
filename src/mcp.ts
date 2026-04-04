#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { runAdd } from './commands/add.js';
import { runCorrect } from './commands/correct.js';
import { runDecay } from './commands/decay.js';
import { runSearch } from './commands/search.js';
import { runStatus } from './commands/status.js';
import { runValidate } from './commands/validate.js';
import { runInit } from './commands/init.js';
import { loadConfig, getProfile } from './lib/config.js';
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
  'Search active project memory before answering questions, planning work, or editing code. Returns ranked active facts, decisions, and procedures.',
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
  'Get a specific memory item by ID. Returns full content including body.',
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
  'Add a new memory item. Types: fact (knowledge), decision (choices made), procedure (how-to steps).',
  {
    type: z.enum(['fact', 'decision', 'procedure']).describe('Memory type'),
    title: z.string().describe('Short title for the memory'),
    body: z.string().optional().describe('Full content/details'),
    source: z.string().optional().describe('Who/what created this memory'),
    tags: z.string().optional().describe('Comma-separated tags'),
    decay_after: z.string().optional().describe('ISO timestamp or "never"'),
  },
  async ({ type, title, body, source, tags, decay_after }) => {
    try {
      const result = runAdd(type, title, {
        cwd: defaultCwd,
        body,
        source,
        tags,
        decayAfter: decay_after,
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
  'memspec_correct',
  'Correct or invalidate an existing memory. Marks the original as corrected and optionally creates a replacement.',
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
  'Show store summary: item counts by type and state, decay candidates, recent items.',
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
  'Check all memory files against the memspec schema. Reports invalid frontmatter.',
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
  'Apply TTL decay to expired items. Can preview (dry-run) or archive.',
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
  'Initialize Memspec in a repo: create .memspec/, import brownfield memory sources when present, and patch AGENTS.md or CLAUDE.md so agents know to use the store.',
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

// --- Start ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`memspec MCP server error: ${err}\n`);
  process.exit(1);
});
