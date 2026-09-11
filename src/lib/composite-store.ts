import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { MemspecStore, type StoreSearchOptions, type LoadWarning, type SearchRelevanceMeta } from './store.js';
import { loadConfig, type StoreLayerConfig } from './config.js';
import { findPointer } from './registry.js';
import { getCodeAnchors, projectRootForStore } from './anchors.js';
import { computeDrift, type DriftInfo } from './drift.js';
import type { MemoryItem, MemoryFrontmatter } from './types.js';

/**
 * Reciprocal Rank Fusion damping constant. 60 is the value from Cormack et
 * al. (2009) and the de-facto default everywhere RRF is used; it flattens the
 * head of the curve so a rank-1 and a rank-3 hit stay within ~3% of each
 * other, keeping near-equal hits near-equal across layers whose absolute
 * scores are not comparable.
 *
 * Note the departure from textbook RRF: contributions are combined with `max`,
 * not `sum` (see `search`). Classic RRF fuses several rankers over ONE corpus,
 * so agreement between them is genuine corroboration worth adding up. Here the
 * layers are DIFFERENT corpora, so the same id in two layers means the record
 * was physically duplicated — an artefact of incomplete migration, not
 * evidence of relevance.
 */
const RRF_K = 60;

export interface StoreLayer {
  name: string;
  store: MemspecStore;
  priority: number;
  writable: boolean;
}

export class CompositeStore {
  readonly layers: StoreLayer[];
  readonly primary: MemspecStore;

  constructor(layers: StoreLayerConfig[], projectRoot?: string) {
    if (layers.length === 0) {
      // Fallback: just the project store
      this.primary = new MemspecStore(projectRoot);
      this.layers = [{ name: 'project', store: this.primary, priority: 10, writable: true }];
      return;
    }

    this.layers = layers
      .map((cfg) => {
        const resolvedPath = cfg.path.startsWith('~')
          ? cfg.path.replace('~', homedir())
          : resolve(projectRoot ?? process.cwd(), cfg.path);
        // MemspecStore takes the parent of .memspec and appends .memspec internally.
        // If the path IS .memspec, we need the parent.
        const storePath = resolvedPath.endsWith('.memspec')
          ? resolve(resolvedPath, '..')
          : resolvedPath;
        return {
          name: cfg.name,
          store: new MemspecStore(storePath),
          priority: cfg.priority,
          writable: cfg.writable,
        };
      })
      .sort((a, b) => b.priority - a.priority); // highest priority first

    // Primary = highest priority writable store
    const writable = this.layers.find((l) => l.writable);
    this.primary = writable?.store ?? this.layers[0].store;
  }

  /**
   * Create a CompositeStore from config, with automatic global store detection.
   * If ~/.memspec exists and no explicit stores config, include it as a low-priority layer.
   */
  static fromConfig(stores: StoreLayerConfig[] | undefined, projectRoot?: string): CompositeStore {
    if (stores && stores.length > 0) {
      return new CompositeStore(stores, projectRoot);
    }

    // Auto-detect global store
    const globalPath = resolve(homedir(), '.memspec');
    const layers: StoreLayerConfig[] = [];

    if (existsSync(globalPath)) {
      layers.push({ name: 'global', path: '~/.memspec', priority: 0, writable: true });
    }

    layers.push({ name: 'project', path: '.memspec', priority: 10, writable: true });

    return new CompositeStore(layers, projectRoot);
  }

  /**
   * v0.6.1 — retrieval entry point used by `search`, `context`, and the MCP
   * `memspec_search` / `memspec_get` handlers. Loads the project's config and
   * honours its `stores:` block; when no explicit layering is configured, falls
   * back to a single-layer composite wrapping the project store. The fallback
   * deliberately skips the auto-global detection that `fromConfig` performs for
   * `memspec stores` — retrieval must stay byte-identical to a single
   * `MemspecStore(cwd)` when no `stores:` block is present.
   *
   * Fixes issue #2 (Mika Tsernobrivoi, @KongFuzi1, 2026-05-31): retrieval paths
   * constructed `MemspecStore` directly, so the configured layers were silently
   * ignored.
   */
  static forCwd(cwd?: string): CompositeStore {
    // A `.memspec.yaml` pointer file (repo without its own store) declares
    // the layers explicitly; a `.memspec/` directory closer to cwd wins.
    const pointer = findPointer(cwd);
    if (pointer) {
      return new CompositeStore(pointer.stores, pointer.dir);
    }
    const probe = new MemspecStore(cwd);
    const config = loadConfig(probe.root);
    if (config.stores && config.stores.length > 0) {
      return new CompositeStore(config.stores, cwd);
    }
    // No explicit layering — preserve v0.6 single-store behaviour exactly.
    return new CompositeStore([], cwd);
  }

  get exists(): boolean {
    return this.layers.some((l) => l.store.exists);
  }

  get root(): string {
    return this.primary.root;
  }

  get warnings(): LoadWarning[] {
    return this.layers.flatMap((l) => l.store.warnings);
  }

  /** Load all items from all layers */
  loadAll(): MemoryItem[] {
    const allItems: MemoryItem[] = [];
    for (const layer of this.layers) {
      if (layer.store.exists) {
        allItems.push(...layer.store.loadAll());
      }
    }
    return allItems;
  }

  /**
   * Load superseded items from all layers, deduplicating by ID (higher priority
   * wins). Mirrors `MemspecStore.loadSuperseded`, used by search expansion when
   * `include_superseded` is set so the walker can resolve archived targets
   * across every configured layer.
   */
  loadSuperseded(): MemoryItem[] {
    const seen = new Set<string>();
    const items: MemoryItem[] = [];
    for (const layer of this.layers) {
      if (!layer.store.exists) continue;
      for (const item of layer.store.loadSuperseded()) {
        if (!seen.has(item.id)) {
          seen.add(item.id);
          items.push(item);
        }
      }
    }
    return items;
  }

  /** Load active items from all layers, deduplicating by ID (higher priority wins) */
  loadActive(): MemoryItem[] {
    const seen = new Set<string>();
    const items: MemoryItem[] = [];

    // Layers are sorted by priority desc, so higher priority items get added first
    for (const layer of this.layers) {
      if (!layer.store.exists) continue;
      for (const item of layer.store.loadActive()) {
        if (!seen.has(item.id)) {
          seen.add(item.id);
          items.push(item);
        }
      }
    }

    return items;
  }

  /**
   * v0.10 — search across all layers with max-combined Reciprocal Rank Fusion.
   *
   * The previous implementation asked every layer for `limit` results and
   * concatenated them in priority order, so relevance never crossed a layer
   * boundary: if the top layer filled the limit, a perfect match in a lower
   * layer was invisible. Priority acted as an absolute gate, not a ranking
   * signal.
   *
   * Merging the underlying scores is not an option. `MemspecStore.search`
   * discards its score, and that score is normalized per result set (divided
   * by the max raw relevance inside that one store's candidate pool), so the
   * top hit of any query is 1.0 regardless of absolute quality. Each layer
   * also carries its own FTS index, so BM25 IDF statistics differ per store.
   * Cross-layer score comparison is therefore meaningless — we fuse on RANK.
   *
   * Layers contribute equally: priority values are 10 (project) / 0 (global),
   * so any multiplicative weighting would zero the global layer out entirely.
   * Priority survives only as a deterministic tie-break and as the authority
   * for which copy of a duplicated id is returned.
   *
   * An id found in several layers takes the MAX of its per-layer
   * contributions, not the sum — i.e. it is scored on its best rank anywhere.
   * See the note on RRF_K for why summing is wrong when layers are separate
   * corpora rather than separate rankers over one corpus.
   *
   * `options.scope` is forwarded verbatim to every layer, where it constrains
   * the FTS candidate set before that layer's limit is applied. Fusing
   * post-filtered pages would reintroduce exactly the starvation the
   * candidate-set filter exists to prevent.
   */
  search(query: string, options: StoreSearchOptions = {}, meta?: SearchRelevanceMeta): MemoryItem[] {
    const limit = options.limit ?? 10;
    if (meta) meta.topBm25 = null;
    const active = this.layers.filter((layer) => layer.store.exists);

    if (active.length === 0) return [];
    // Single layer: delegate untouched. Routing this through fusion would
    // change the per-layer limit, which changes the per-set normalization
    // denominator inside MemspecStore.search and silently reorders results.
    // `forCwd` promises byte-identical behaviour to a bare MemspecStore here.
    // The BM25 meta is only meaningful for a single corpus, so it is forwarded
    // here and left null across a rank-fused multi-layer query (coverage then
    // falls back to the body-match signal).
    if (active.length === 1) return active[0].store.search(query, options, meta);

    // Over-fetch so fusion has material below the caller's cut.
    const perLayerLimit = Math.max(limit * 2, 20);

    interface FusedEntry {
      item: MemoryItem;
      priority: number;
      bestRank: number;
      score: number;
    }
    const fused = new Map<string, FusedEntry>();

    // Layers are sorted priority-descending, so the first layer holding an id
    // is the authoritative copy.
    for (const layer of active) {
      let results: MemoryItem[];
      try {
        results = layer.store.search(query, { ...options, limit: perLayerLimit });
      } catch {
        // A broken layer (corrupt index, unreadable file) must not fail the
        // whole query — the remaining layers still have answers.
        continue;
      }

      results.forEach((item, index) => {
        const rank = index + 1;
        const contribution = 1 / (RRF_K + rank);
        const existing = fused.get(item.id);
        if (existing) {
          // `max`, not `sum`. Duplication across layers is a migration
          // artefact, not corroboration, so a record is scored on its best
          // showing anywhere rather than boosted for existing twice. Without
          // this, records transiently present in both a global and a project
          // store during migration would outrank better single-layer hits.
          existing.score = Math.max(existing.score, contribution);
          existing.bestRank = Math.min(existing.bestRank, rank);
        } else {
          fused.set(item.id, {
            item,
            priority: layer.priority,
            bestRank: rank,
            score: contribution,
          });
        }
      });
    }

    return Array.from(fused.values())
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (b.priority !== a.priority) return b.priority - a.priority;
        if (a.bestRank !== b.bestRank) return a.bestRank - b.bestRank;
        return a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0;
      })
      .slice(0, limit)
      .map((entry) => entry.item);
  }

  /**
   * Union of the scopes stamped on records across every layer. A scope
   * that only exists in the global layer is still a real scope from the
   * project's point of view, so validation has to see all of them.
   */
  scopesInUse(): string[] {
    const seen = new Set<string>();
    for (const layer of this.layers) {
      if (!layer.store.exists) continue;
      for (const scope of layer.store.scopesInUse()) seen.add(scope);
    }
    return [...seen];
  }

  /**
   * DEFECT B — read-path drift for the given items, resolved against each
   * item's own layer (its projectRoot + `anchors.repo_search_paths`). Only
   * active, anchored records are checked; everything else is absent from the
   * returned map. Never throws — an unavailable repo is `anchor_unchecked`, not
   * drift. Bounded to at most one `loadActive` per layer, and only when the
   * store is actually layered.
   */
  annotateDrift(items: MemoryItem[]): Map<string, DriftInfo> {
    const out = new Map<string, DriftInfo>();
    const anchored = items.filter((i) => i.state === 'active' && getCodeAnchors(i).length > 0);
    if (anchored.length === 0) return out;

    // Single layer (the personal store and every non-layered project): one
    // projectRoot, no ownership lookup needed.
    if (this.layers.length === 1) {
      const store = this.layers[0].store;
      const projectRoot = projectRootForStore(store.root);
      const repoSearchPaths = loadConfig(store.root).anchors?.repo_search_paths;
      for (const item of anchored) {
        const drift = computeDrift(projectRoot, getCodeAnchors(item), { repoSearchPaths });
        if (drift) out.set(item.id, drift);
      }
      return out;
    }

    // Layered: map each item to the highest-priority layer that holds it, so a
    // cross-repo anchor resolves against the right projectRoot.
    const pending = new Map(anchored.map((i) => [i.id, i]));
    for (const layer of this.layers) {
      if (pending.size === 0) break;
      if (!layer.store.exists) continue;
      const projectRoot = projectRootForStore(layer.store.root);
      const repoSearchPaths = loadConfig(layer.store.root).anchors?.repo_search_paths;
      const idsHere = new Set(layer.store.loadActive().map((i) => i.id));
      for (const [id, item] of [...pending]) {
        if (!idsHere.has(id)) continue;
        const drift = computeDrift(projectRoot, getCodeAnchors(item), { repoSearchPaths });
        if (drift) out.set(id, drift);
        pending.delete(id);
      }
    }
    return out;
  }

  /** Find by ID across all layers (highest priority first) */
  findById(id: string): MemoryItem | null {
    for (const layer of this.layers) {
      if (!layer.store.exists) continue;
      const item = layer.store.findById(id);
      if (item) return item;
    }
    return null;
  }

  /** Write to a specific layer by name, or primary by default */
  writeItem(item: MemoryFrontmatter & { title: string; body: string }, layerName?: string): string {
    const target = layerName
      ? this.layers.find((l) => l.name === layerName)
      : this.layers.find((l) => l.writable);

    if (!target) throw new Error('No writable store layer available');
    if (!target.writable) throw new Error(`Store layer '${target.name}' is not writable`);

    target.store.init();
    return target.store.writeItem(item);
  }

  /** Get the store for a specific layer */
  getLayer(name: string): StoreLayer | undefined {
    return this.layers.find((l) => l.name === name);
  }

  /** List available layers */
  listLayers(): Array<{ name: string; path: string; priority: number; writable: boolean; exists: boolean; itemCount: number }> {
    return this.layers.map((l) => ({
      name: l.name,
      path: l.store.root,
      priority: l.priority,
      writable: l.writable,
      exists: l.store.exists,
      itemCount: l.store.exists ? l.store.loadAll().length : 0,
    }));
  }
}
