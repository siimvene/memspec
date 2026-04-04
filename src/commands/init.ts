import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { resolve } from 'node:path';
import { MemspecStore } from '../lib/store.js';
import type { ConfigGenerationOptions } from '../lib/config.js';
import { detectBrownfieldSources, importBrownfield } from '../lib/brownfield.js';
import { patchAgentInstructions } from '../lib/agent-addon.js';

export interface InitOptions extends ConfigGenerationOptions {
  cwd?: string;
  interactive?: boolean;
  skipImport?: boolean;
  skipPatch?: boolean;
}

interface PromptIo {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  isTty?: boolean;
  ask?: (question: string) => Promise<string>;
}

type SearchEngineChoice = 'fts5' | 'hybrid';
type EmbeddingsProviderChoice = 'openai' | 'ollama';

const DEFAULT_OPENAI_ENDPOINT = 'https://api.openai.com/v1/embeddings';
const DEFAULT_OPENAI_MODEL = 'text-embedding-3-small';
const DEFAULT_OLLAMA_ENDPOINT = 'http://localhost:11434/api/embed';
const DEFAULT_OLLAMA_MODEL = 'nomic-embed-text';

async function prompt(question: string, io: PromptIo): Promise<string> {
  if (io.ask) {
    return (await io.ask(question)).trim();
  }

  const rl = createInterface({
    input: io.input ?? input,
    output: io.output ?? output,
  });

  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

function normalizeSearchEngine(raw: string | undefined): SearchEngineChoice | null {
  if (!raw) return null;
  const value = raw.trim().toLowerCase();
  if (value === '1' || value === 'fts5' || value === 'keyword') return 'fts5';
  if (value === '2' || value === 'hybrid') return 'hybrid';
  return null;
}

function normalizeEmbeddingsProvider(raw: string | undefined): EmbeddingsProviderChoice | null {
  if (!raw) return null;
  const value = raw.trim().toLowerCase();
  if (value === '1' || value === 'openai') return 'openai';
  if (value === '2' || value === 'ollama') return 'ollama';
  return null;
}

async function resolveInteractiveConfig(options: InitOptions, io: PromptIo): Promise<ConfigGenerationOptions> {
  const resolved: ConfigGenerationOptions = {
    searchEngine: options.searchEngine,
    embeddingsProvider: options.embeddingsProvider,
    embeddingsEndpoint: options.embeddingsEndpoint,
    embeddingsModel: options.embeddingsModel,
    embeddingsApiKey: options.embeddingsApiKey,
  };

  if (!resolved.searchEngine) {
    while (!resolved.searchEngine) {
      const answer = await prompt(
        [
          'Search engine:',
          '  1) FTS5 only (default, zero setup)',
          '  2) Hybrid (FTS5 + embeddings)',
          '> ',
        ].join('\n'),
        io,
      );

      resolved.searchEngine = normalizeSearchEngine(answer === '' ? 'fts5' : answer) ?? undefined;
    }
  }

  if (resolved.searchEngine !== 'hybrid') {
    return resolved;
  }

  if (!resolved.embeddingsProvider) {
    while (!resolved.embeddingsProvider) {
      const answer = await prompt(
        [
          'Embeddings source:',
          '  1) OpenAI-compatible API (OpenAI, sglang, vLLM, local proxies)',
          '  2) Ollama local endpoint',
          '> ',
        ].join('\n'),
        io,
      );

      resolved.embeddingsProvider =
        normalizeEmbeddingsProvider(answer === '' ? 'openai' : answer) ?? undefined;
    }
  }

  if (resolved.embeddingsProvider === 'ollama') {
    if (!resolved.embeddingsEndpoint) {
      const answer = await prompt(
        `Ollama endpoint [${DEFAULT_OLLAMA_ENDPOINT}]: `,
        io,
      );
      resolved.embeddingsEndpoint = answer || DEFAULT_OLLAMA_ENDPOINT;
    }

    if (!resolved.embeddingsModel) {
      const answer = await prompt(
        `Ollama model [${DEFAULT_OLLAMA_MODEL}]: `,
        io,
      );
      resolved.embeddingsModel = answer || DEFAULT_OLLAMA_MODEL;
    }

    return resolved;
  }

  if (!resolved.embeddingsEndpoint) {
    const answer = await prompt(
      `Embeddings endpoint [${DEFAULT_OPENAI_ENDPOINT}]: `,
      io,
    );
    resolved.embeddingsEndpoint = answer || DEFAULT_OPENAI_ENDPOINT;
  }

  if (!resolved.embeddingsModel) {
    const answer = await prompt(
      `Embeddings model [${DEFAULT_OPENAI_MODEL}]: `,
      io,
    );
    resolved.embeddingsModel = answer || DEFAULT_OPENAI_MODEL;
  }

  if (resolved.embeddingsApiKey === undefined) {
    const answer = await prompt(
      'API key (leave blank to configure later): ',
      io,
    );
    resolved.embeddingsApiKey = answer || undefined;
  }

  return resolved;
}

function shouldPromptInteractively(options: InitOptions, io: PromptIo): boolean {
  if (options.interactive === false) return false;
  if (options.searchEngine) return false;
  const inStream = io.input ?? input;
  const outStream = io.output ?? output;
  const inputIsTty = 'isTTY' in inStream ? Boolean(inStream.isTTY) : false;
  const outputIsTty = 'isTTY' in outStream ? Boolean(outStream.isTTY) : false;
  return io.isTty ?? (inputIsTty && outputIsTty);
}

export async function runInit(options: InitOptions, io: PromptIo = {}): Promise<string> {
  const store = new MemspecStore(options.cwd);
  const projectRoot = resolve(options.cwd ?? process.cwd());

  const config = shouldPromptInteractively(options, io)
    ? await resolveInteractiveConfig(options, io)
    : {
      searchEngine: options.searchEngine,
      embeddingsProvider: options.embeddingsProvider,
      embeddingsEndpoint: options.embeddingsEndpoint,
      embeddingsModel: options.embeddingsModel,
      embeddingsApiKey: options.embeddingsApiKey,
    };

  store.init(config);

  const lines = [`Initialized Memspec store at ${store.root}`];

  if (!options.skipImport) {
    const sources = detectBrownfieldSources(projectRoot);
    const existingItems = store.loadAll().length;
    if (sources.length > 0 && existingItems === 0) {
      const result = importBrownfield(projectRoot, store);
      const total = result.imported.facts +
        result.imported.decisions +
        result.imported.procedures +
        result.imported.observations;
      if (total > 0) {
        lines.push(`Detected existing memory: ${sources.join(', ')}`);
        lines.push(
          `Imported: ${result.imported.facts} facts, ${result.imported.decisions} decisions, ` +
          `${result.imported.procedures} procedures, ${result.imported.observations} observations`,
        );
      }
    } else if (sources.length > 0 && existingItems > 0) {
      lines.push(`Detected existing memory: ${sources.join(', ')}`);
      lines.push('Skipped brownfield import because the memspec store already contains items');
    }
  }

  if (!options.skipPatch) {
    const patch = patchAgentInstructions(projectRoot);
    if (patch.changed) {
      lines.push(`${patch.created ? 'Created' : 'Patched'} ${patch.path} with memspec instructions`);
    } else {
      lines.push(`Agent instructions already configured at ${patch.path}`);
    }
  }

  return lines.join('\n');
}
