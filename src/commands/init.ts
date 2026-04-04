import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { MemspecStore } from '../lib/store.js';
import type { ConfigGenerationOptions } from '../lib/config.js';

export interface InitOptions extends ConfigGenerationOptions {
  cwd?: string;
  interactive?: boolean;
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

  return `Initialized Memspec store at ${store.root}`;
}
