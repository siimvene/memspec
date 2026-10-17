import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import type { MemoryType } from './types.js';
import { DEFAULT_DECAY_DAYS } from './types.js';

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

export interface AnchorsConfig {
  /** Directories searched (after the project root's parent) for cross-repo anchor checkouts. */
  repo_search_paths?: string[];
}

/**
 * Map of scope name → working-directory path patterns. Patterns use the same
 * semantics as `claims:` (see `matchesClaim` in registry.ts): `~` expands to
 * the home directory, a pattern without wildcards claims that path and
 * everything under it, `*` matches within a segment and `**` across segments.
 */
export type ScopesConfig = Record<string, string[]>;

/**
 * Thrown when config.yaml parses as YAML but declares something structurally
 * invalid. Unlike every other parse failure in `loadConfig` (which falls back
 * to defaults) this propagates: a typo in a scope pattern must be loud, not a
 * silently empty scope that hides every record in the project.
 */
export class MemspecConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemspecConfigError';
  }
}

export interface MemspecConfig {
  decay: Record<string, string>;
  profiles: Record<string, MemspecProfile>;
  stabilization: StabilizationConfig;
  stores?: StoreLayerConfig[];
  anchors?: AnchorsConfig;
  /** Read-side routing: which records are visible from which working directories. */
  scopes?: ScopesConfig;
  /**
   * v0.11 — when true, `remember`/`observe` refuse to write a record whose
   * scope resolves to nothing (no `--scope` passed, and cwd matches no
   * `scopes:` pattern). Pass `--scope universal` to opt out explicitly for a
   * record that genuinely belongs everywhere. Default false — a store with no
   * `scopes_require` behaves exactly as before scoping existed.
   */
  scopes_require?: boolean;
  /**
   * Write-side routing for `memspec reduce`: working directories whose
   * experience digests this store owns. Typed here so typos surface; the
   * runtime consumer is still `claimsOf()` in registry.ts.
   */
  claims?: string[];
  /**
   * Days an assertion-witnessed claim may go unverified before search and
   * `memspec_get` mark it `aged: true` (see `agingOf` in decay.ts). Separate
   * from `check_by`: a claim can sit inside its review window and still rest
   * on nothing but its author's word. 0 disables the signal. Read through
   * `getAgingDays`, which applies the default (90).
   */
  aging_days?: number;
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
  stabilization: {
    enabled: false,
    min_confirmations: 2,
    auto_promote_confidence: 0.9,
  },
  scopes_require: false,
};

/**
 * Scope name reserved for records that are explicitly visible everywhere.
 * Declaring it as a scope would make `scope: universal` mean two things.
 */
const RESERVED_SCOPE_NAMES = new Set(['universal']);

/**
 * Path patterns are matched against a resolved cwd. A relative pattern would
 * resolve against whatever directory the process happens to be in, which is
 * never what the author meant — reject it instead of matching by accident.
 */
function assertPatternList(value: unknown, label: string, configPath: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new MemspecConfigError(
      `${configPath}: ${label} must be a non-empty list of path patterns`,
    );
  }
  return value.map((pattern) => {
    if (typeof pattern !== 'string' || pattern.trim().length === 0) {
      throw new MemspecConfigError(
        `${configPath}: ${label} must contain only non-empty path patterns (got ${JSON.stringify(pattern)})`,
      );
    }
    const trimmed = pattern.trim();
    if (!trimmed.startsWith('~') && !trimmed.startsWith('/')) {
      throw new MemspecConfigError(
        `${configPath}: ${label} pattern "${trimmed}" must be absolute or start with "~" — ` +
          'relative patterns resolve against the current working directory and never match reliably',
      );
    }
    return trimmed;
  });
}

export function parseScopesConfig(raw: unknown, configPath: string): ScopesConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new MemspecConfigError(
      `${configPath}: scopes must be a mapping of scope name to path patterns`,
    );
  }

  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) return undefined;

  // Null-prototype: the keys are config-controlled, and `scopes['__proto__'] =
  // [...]` on a normal object literal writes through to the prototype instead
  // of creating an own property — the scope then vanishes from Object.keys and
  // Object.entries, so it silently claims nothing while looking declared.
  const scopes: ScopesConfig = Object.create(null) as ScopesConfig;
  for (const [name, patterns] of entries) {
    if (name.trim().length === 0 || /\s/.test(name)) {
      throw new MemspecConfigError(
        `${configPath}: scope name ${JSON.stringify(name)} must be a non-empty token without whitespace`,
      );
    }
    if (RESERVED_SCOPE_NAMES.has(name)) {
      throw new MemspecConfigError(
        `${configPath}: "${name}" is a reserved scope name — records marked \`scope: ${name}\` are visible from every scope, so it cannot also name a directory-bound scope`,
      );
    }
    scopes[name] = assertPatternList(patterns, `scopes.${name}`, configPath);
  }
  return scopes;
}

export function parseClaimsConfig(raw: unknown, configPath: string): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  return assertPatternList(raw, 'claims', configPath);
}

/**
 * A legacy `search:` block (hybrid retrieval config from pre-0.11 stores) is
 * ignored rather than rejected — deployed stores on other machines may still
 * carry one. Warn once per process so the message doesn't spam every call
 * into a config-heavy command.
 */
let warnedAboutLegacySearchBlock = false;

export function loadConfig(root: string): MemspecConfig {
  const configPath = join(root, 'config.yaml');
  if (!existsSync(configPath)) return DEFAULT_CONFIG;

  try {
    const raw = readFileSync(configPath, 'utf8');
    // Use gray-matter's engine to parse bare YAML (wrap in fake frontmatter)
    const parsed = matter(`---\n${raw}\n---\n`);
    const data = parsed.data as Record<string, unknown> | null;
    if (!data) return DEFAULT_CONFIG;

    if (data.search !== undefined && !warnedAboutLegacySearchBlock) {
      warnedAboutLegacySearchBlock = true;
      process.stderr.write('memspec: config `search:` block is ignored (hybrid retrieval was removed in 0.11)\n');
    }

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

    const anchorsData = data.anchors as Record<string, unknown> | undefined;
    const anchors: AnchorsConfig | undefined = anchorsData
      ? {
          repo_search_paths: Array.isArray(anchorsData.repo_search_paths)
            ? (anchorsData.repo_search_paths as unknown[]).filter((p): p is string => typeof p === 'string')
            : undefined,
        }
      : undefined;

    const scopes = parseScopesConfig(data.scopes, configPath);
    const claims = parseClaimsConfig(data.claims, configPath);
    const scopesRequire = typeof data.scopes_require === 'boolean' ? data.scopes_require : DEFAULT_CONFIG.scopes_require;
    const agingDays = parseAgingDays(data.aging_days, configPath);

    return {
      decay: { ...DEFAULT_CONFIG.decay, ...(data.decay as Record<string, string> ?? {}) },
      profiles: { ...DEFAULT_CONFIG.profiles, ...(data.profiles as MemspecConfig['profiles'] ?? {}) },
      stabilization,
      stores,
      anchors,
      scopes,
      scopes_require: scopesRequire,
      claims,
      ...(agingDays !== undefined ? { aging_days: agingDays } : {}),
    };
  } catch (err) {
    // Structural config errors are the one failure we refuse to swallow —
    // silently falling back to defaults would turn a typo'd scope pattern into
    // an invisible retrieval filter.
    if (err instanceof MemspecConfigError) throw err;
    return DEFAULT_CONFIG;
  }
}

/** Parse a duration string like "90d", "7d", "180d" into days. Returns null if unparseable. */
/** Default for `aging_days:` when the config does not set it. */
export const DEFAULT_AGING_DAYS = 90;

/**
 * `aging_days:` — a non-negative integer, or absent. Refused loudly rather
 * than defaulted: a typo that silently fell back to 90 (or to 0) would change
 * which claims are shown as unverified without anyone noticing.
 */
function parseAgingDays(value: unknown, configPath: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new MemspecConfigError(
      `${configPath}: aging_days must be a non-negative integer (days; 0 disables the aging signal), got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

export function getAgingDays(config: MemspecConfig): number {
  return config.aging_days ?? DEFAULT_AGING_DAYS;
}

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

/** `getDecayDays` for every memory type: the per-type TTL table the store's `decay:` block configures. */
export function decayDaysByType(config: MemspecConfig): Record<MemoryType, number> {
  const out = { ...DEFAULT_DECAY_DAYS };
  for (const type of Object.keys(out) as MemoryType[]) out[type] = getDecayDays(config, type);
  return out;
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

export function defaultConfigYaml(): string {
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
# Record scoping (optional)
# Partitions one store by working directory so a query issued in one project
# doesn't surface records from every other project sharing the store. A record
# with no scope is visible everywhere (the default); scope: universal is
# explicitly visible everywhere; any other value is visible only when that
# scope is active. Patterns use the same syntax as claims: below.
# scopes:
#   kleidia: [~/git/kleidia, ~/git/kleidia-docs]
#   plg: ['~/piletilevi/**']
#
# When true, remember/observe refuse to write a record whose scope resolves to
# nothing (no --scope passed, cwd matches no pattern above). Pass
# --scope universal for a record that genuinely belongs everywhere.
# scopes_require: true
`;

  yaml += `
# Aging signal (optional)
# Search hits and memspec_get results witnessed only by assertion, and not
# verified for longer than this many days, carry aged: true plus
# unverified_days. Independent of check_by; 0 disables it.
# aging_days: 90
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

  return yaml;
}
