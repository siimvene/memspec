/**
 * Embedding provider interface for memspec.
 *
 * Supports pluggable backends: custom function, OpenAI-compatible API, or local model.
 * The store uses embeddings for hybrid search (FTS5 candidates re-ranked by vector similarity).
 */

export interface EmbeddingProvider {
  /** Embed one or more texts, returning a vector per text. */
  embed(texts: string[]): Promise<number[][]>;
  /** Dimensionality of the vectors this provider produces. */
  dimensions?: number;
}

export interface CustomProviderConfig {
  provider: 'custom';
  embed: (texts: string[]) => Promise<number[][]>;
}

export interface ApiProviderConfig {
  provider: 'openai' | 'ollama';
  endpoint: string;
  model: string;
  apiKey?: string;
}

export type EmbeddingProviderConfig = CustomProviderConfig | ApiProviderConfig;

/**
 * Create an embedding provider from config.
 */
export function createEmbeddingProvider(config: EmbeddingProviderConfig): EmbeddingProvider {
  if (config.provider === 'custom') {
    return { embed: config.embed };
  }

  // API-backed providers. "openai" expects the OpenAI embeddings shape.
  // "ollama" uses Ollama's native embedding endpoint response.
  return {
    async embed(texts: string[]): Promise<number[][]> {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (config.apiKey) {
        headers['Authorization'] = `Bearer ${config.apiKey}`;
      }

      const body = config.provider === 'ollama'
        ? JSON.stringify({
          model: config.model,
          input: texts,
        })
        : JSON.stringify({
          model: config.model,
          input: texts,
        });

      const response = await fetch(config.endpoint, {
        method: 'POST',
        headers,
        body,
      });

      if (!response.ok) {
        throw new Error(`Embedding API error: ${response.status} ${response.statusText}`);
      }

      if (config.provider === 'ollama') {
        const data = await response.json() as { embeddings?: number[][]; embedding?: number[] };
        if (Array.isArray(data.embeddings)) return data.embeddings;
        if (Array.isArray(data.embedding)) return [data.embedding];
        throw new Error('Embedding API error: invalid Ollama embeddings response');
      }

      const data = await response.json() as {
        data: Array<{ embedding: number[]; index: number }>;
      };

      return data.data
        .sort((a, b) => a.index - b.index)
        .map((d) => d.embedding);
    },
  };
}

/**
 * Cosine similarity between two vectors. Returns value in [-1, 1].
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error('Vector dimension mismatch');

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Load an embedding provider from memspec config.
 * Returns null if no embeddings are configured.
 */
export function loadEmbeddingProvider(config: {
  provider?: string;
  endpoint?: string;
  model?: string;
  api_key?: string;
} | undefined): EmbeddingProvider | null {
  if (!config || !config.provider) return null;

  if (config.provider === 'openai' || config.provider === 'ollama') {
    if (!config.endpoint || !config.model) return null;
    return createEmbeddingProvider({
      provider: config.provider,
      endpoint: config.endpoint,
      model: config.model,
      apiKey: config.api_key,
    });
  }

  return null;
}
