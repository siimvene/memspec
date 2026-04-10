import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import type { MemoryType } from './types.js';
import { DEFAULT_DECAY_DAYS } from './types.js';

export interface EmbeddingsConfig {
  provider?: string;
  endpoint?: string;
  model?: string;
  api_key?: string;
}

export interface SearchConfig {
  engine: 'fts5' | 'hybrid';
  embeddings?: EmbeddingsConfig;
}

export interface StabilizationConfig {
  enabled: boolean;
  min_confirmations: number;
  auto_promote_confidence: number;
}

export interface StoreLayerConfig {
  name: string;
  path: string;
  priority: number;    // higher = takes precedence
  writable: boolean;   // can this layer be written to?
}

export interface MemspecConfig {
  decay: Record<string, string>;
  profiles: Record<string, MemspecProfile>;
  search: SearchConfig;
  stabilization: StabilizationConfig;
  stores?: StoreLayerConfig[];
}

export interface MemspecProfile {
  max_tokens?: number;
  types?: string[];
  min_confidence?: number;
  ranking?: Record<string, number>;
}

const DEFAULT_CONFIG: MemspecConfig = {
  decay: {
    fact: '90d',
    decision: '180d',
    procedure: '90d',
    observation: '7d',
  },
  profiles: {
    default: {
      max_tokens: 2000,
      types: ['fact', 'decision', 'procedure'],
      min_confidence: 0.7,
      ranking: { relevance: 0.4, confidence: 0.3, recency: 0.3 },
    },
  },
  search: {
    engine: 'fts5',
  },
  stabilization: {
    enabled: false,
    min_confirmations: 2,
    auto_promote_confidence: 0.9,
  },
};

export function loadConfig(root: string): MemspecConfig {
  const configPath = join(root, 'config.yaml');
  if (!existsSync(configPath)) return DEFAULT_CONFIG;

  try {
    const raw = readFileSync(configPath, 'utf8');
    // Use gray-matter's engine to parse bare YAML (wrap in fake frontmatter)
    const parsed = matter(`---\n${raw}\n---\n`);
    const data = parsed.data as Record<string, unknown> | null;
    if (!data) return DEFAULT_CONFIG;

    const searchData = data.search as Record<string, unknown> | undefined;
    const search: SearchConfig = {
      engine: (searchData?.engine as 'fts5' | 'hybrid') ?? 'fts5',
      embeddings: searchData?.embeddings as EmbeddingsConfig | undefined,
    };

    const stabData = data.stabilization as Record<string, unknown> | undefined;
    const stabilization: StabilizationConfig = {
      ...DEFAULT_CONFIG.stabilization,
      ...(stabData ? {
        enabled: typeof stabData.enabled === 'boolean' ? stabData.enabled : DEFAULT_CONFIG.stabilization.enabled,
        min_confirmations: typeof stabData.min_confirmations === 'number' ? stabData.min_confirmations : DEFAULT_CONFIG.stabilization.min_confirmations,
        auto_promote_confidence: typeof stabData.auto_promote_confidence === 'number' ? stabData.auto_promote_confidence : DEFAULT_CONFIG.stabilization.auto_promote_confidence,
      } : {}),
    };

    const stores = Array.isArray(data.stores)
      ? (data.stores as StoreLayerConfig[])
      : undefined;

    return {
      decay: { ...DEFAULT_CONFIG.decay, ...(data.decay as Record<string, string> ?? {}) },
      profiles: { ...DEFAULT_CONFIG.profiles, ...(data.profiles as MemspecConfig['profiles'] ?? {}) },
      search,
      stabilization,
      stores,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

/** Parse a duration string like "90d", "7d", "180d" into days. Returns null if unparseable. */
export function parseDurationDays(duration: string): number | null {
  const match = duration.match(/^(\d+)d$/);
  return match ? parseInt(match[1], 10) : null;
}

/** Get decay days for a memory type from config */
export function getDecayDays(config: MemspecConfig, type: MemoryType): number {
  const raw = config.decay[type];
  if (!raw) return DEFAULT_DECAY_DAYS[type] ?? 90;
  const days = parseDurationDays(raw);
  return days ?? DEFAULT_DECAY_DAYS[type] ?? 90;
}

export function getProfile(config: MemspecConfig, name: string = 'default'): MemspecProfile {
  const fallback = config.profiles.default ?? DEFAULT_CONFIG.profiles.default;
  const requested = config.profiles[name] ?? fallback;

  return {
    ...fallback,
    ...requested,
    ranking: {
      ...(fallback.ranking ?? {}),
      ...(requested.ranking ?? {}),
    },
  };
}

export interface ConfigGenerationOptions {
  searchEngine?: 'fts5' | 'hybrid';
  embeddingsProvider?: string;
  embeddingsEndpoint?: string;
  embeddingsModel?: string;
  embeddingsApiKey?: string;
}

export function defaultConfigYaml(options: ConfigGenerationOptions = {}): string {
  let yaml = `# Memspec configuration
# Files are canonical. Derived indexes are disposable.

classification:
  llm: false
  fallback: rules

decay:
  fact: 90d
  decision: 180d
  procedure: 90d
  observation: 7d

profiles:
  default:
    max_tokens: 2000
    types: [fact, decision, procedure]
    min_confidence: 0.7
    ranking:
      relevance: 0.4
      confidence: 0.3
      recency: 0.3
`;

  yaml += `
# Stabilization gate (optional)
# When enabled, new memories start as captured and require confirmations
# before promotion to active state.
# stabilization:
#   enabled: true
#   min_confirmations: 2
#   auto_promote_confidence: 0.9
`;

  yaml += `
# Store composition (optional)
# Layer multiple stores with precedence. Higher priority wins on conflicts.
# stores:
#   - name: global
#     path: ~/.memspec
#     priority: 0
#     writable: true
#   - name: project
#     path: .memspec
#     priority: 10
#     writable: true
`;

  if (options.searchEngine === 'hybrid' && options.embeddingsProvider) {
    yaml += `
search:
  engine: hybrid
  embeddings:
    provider: ${options.embeddingsProvider}
`;
    if (options.embeddingsEndpoint) {
      yaml += `    endpoint: ${options.embeddingsEndpoint}\n`;
    }
    if (options.embeddingsModel) {
      yaml += `    model: ${options.embeddingsModel}\n`;
    }
    if (options.embeddingsApiKey) {
      yaml += `    api_key: ${options.embeddingsApiKey}\n`;
    }
  } else {
    yaml += `
search:
  engine: fts5
`;
  }

  return yaml;
}
