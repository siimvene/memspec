import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { MemspecStore, type StoreSearchOptions, type LoadWarning, type SearchRelevanceMeta } from './store.js';
import { loadConfig, type StoreLayerConfig } from './config.js';
import { findPointer, POINTER_FILENAME } from './registry.js';
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

/**
 * A record in a READ-ONLY layer that an active record in a writable layer
 * supersedes (`supersedes: [target_id]`). The read view treats the target as
 * superseded; the read-only layer itself only learns about it when the local
 * record is promoted there (a PR to the team repo), hence "pending promotion".
 */
export interface PendingPromotion {
  /** The local (writable-layer) record that supersedes the target. */
  id: string;
  /** The superseded record's id in the read-only layer. */
  target_id: string;
  /** Name of the read-only layer holding the target — where the promotion goes. */
  target_layer: string;
}

/** Result of `CompositeStore.resolveWritable`: the layer a write must target. */
export interface WritableResolution {
  layer: StoreLayer;
  composite: CompositeStore;
  /** Where the layer list came from: a `.memspec.yaml` pointer, a store's `stores:` block, or no layering at all. */
  via: 'pointer' | 'config' | 'single';
}

/**
 * Follow `superseded_by` from a local record to the record that currently
 * carries its claim: itself when active, its active successor when it was
 * replaced locally (a correction of a correction still supersedes the
 * read-only original), or null when the chain ends retired, missing, or loops
 * — a retracted correction withdraws its claim on the target.
 */
function liveEndOfChain(start: MemoryItem, local: ReadonlyMap<string, MemoryItem>): MemoryItem | null {
  const visited = new Set<string>();
  let cur: MemoryItem | undefined = start;
  while (cur && !visited.has(cur.id)) {
    if (cur.state === 'active') return cur;
    if (cur.state !== 'superseded' || !cur.superseded_by) return null;
    visited.add(cur.id);
    cur = local.get(cur.superseded_by);
  }
  return null;
}

export class CompositeStore {
  readonly layers: StoreLayer[];
  readonly primary: MemspecStore;
  /**
   * DEFECT #20 — names of configured layers whose store directory does not
   * exist on this machine (not cloned, typo, moved). Every read skips them
   * silently; this list lets `search`/`status` say so instead of reporting
   * `coverage: none` as if the store were empty. Empty for the unlayered
   * fallback (a not-yet-created project store is a normal state, not a
   * missing layer).
   */
  readonly layersUnavailable: string[];
  /** File that declared the layers (config.yaml or .memspec.yaml), for messages. */
  readonly declaredIn: string | undefined;

  /**
   * @param layers       Layer declarations (from a `stores:` block or pointer).
   * @param projectRoot  Directory RELATIVE layer paths resolve against — the
   *   directory holding the config/pointer that declared them, never the
   *   caller's cwd (#1). Also the cwd for the unlayered fallback.
   * @param declaredIn   The declaring file, named in warnings and errors.
   */
  constructor(layers: StoreLayerConfig[], projectRoot?: string, declaredIn?: string) {
    this.declaredIn = declaredIn;
    if (layers.length === 0) {
      // Fallback: just the project store
      this.primary = new MemspecStore(projectRoot);
      this.layers = [{ name: 'project', store: this.primary, priority: 10, writable: true }];
      this.layersUnavailable = [];
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
          // Explicit layer path: never walk upward (C1). The path was computed
          // deliberately from config/pointer; climbing could silently rebind a
          // team layer to the personal store when its `.memspec` is missing.
          store: new MemspecStore(storePath, { walk: false }),
          priority: cfg.priority,
          writable: cfg.writable,
        };
      })
      .sort((a, b) => b.priority - a.priority); // highest priority first

    // Primary = highest priority writable store
    const writable = this.layers.find((l) => l.writable);
    this.primary = writable?.store ?? this.layers[0].store;
    this.layersUnavailable = this.layers.filter((l) => !l.store.exists).map((l) => l.name);
  }

  /**
   * #20 — the unavailable layers with their resolved paths, for notes and
   * JSON. Derived from `layersUnavailable` (fixed at construction), so the
   * unlayered fallback — whose single project store may simply not exist yet —
   * never reports itself as a missing layer.
   */
  unavailableLayers(): Array<{ name: string; path: string; writable: boolean }> {
    return this.layers
      .filter((l) => this.layersUnavailable.includes(l.name))
      .map((l) => ({ name: l.name, path: l.store.root, writable: l.writable }));
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
    return CompositeStore.resolveLayered(cwd).composite;
  }

  /**
   * The one place that turns a cwd into a layer set — shared by the read path
   * (`forCwd`) and the write path (`resolveWritable`), so both agree on which
   * stores are in scope. Order:
   *
   *   1. A `.memspec.yaml` pointer file (repo without its own store) declares
   *      the layers explicitly; a `.memspec/` directory closer to cwd wins.
   *   2. The walked-up store's own config.yaml `stores:` block. Relative layer
   *      paths resolve against THAT store's parent directory — the directory
   *      holding the config that declared them — never against the caller's
   *      cwd (#1: from `repo/service/api`, `path: .memspec` used to resolve to
   *      `repo/service/api/.memspec`, a phantom, so retrieval saw nothing).
   *   3. No layering: a single-layer composite over the walked-up store,
   *      byte-identical to a bare `MemspecStore(cwd)`.
   */
  private static resolveLayered(cwd?: string): { composite: CompositeStore; via: WritableResolution['via'] } {
    const pointer = findPointer(cwd);
    if (pointer) {
      return {
        composite: new CompositeStore(pointer.stores, pointer.dir, join(pointer.dir, POINTER_FILENAME)),
        via: 'pointer',
      };
    }
    const probe = new MemspecStore(cwd);
    const config = loadConfig(probe.root);
    if (config.stores && config.stores.length > 0) {
      return {
        composite: new CompositeStore(config.stores, dirname(probe.root), probe.configPath),
        via: 'config',
      };
    }
    // No explicit layering — preserve v0.6 single-store behaviour exactly.
    return { composite: new CompositeStore([], cwd), via: 'single' };
  }

  /**
   * #45 — the layer a WRITE from `cwd` must land in, resolved through the same
   * layer set the read path uses. Before this, `remember`/`observe`/`question`
   * honoured a `.memspec.yaml` pointer but ignored a walked-up store's own
   * `stores:` block and wrote into the probe store, which is not a layer of
   * the read view for that cwd — the record was unsearchable from where it
   * was written.
   *
   *   - `storeName` given: that layer, or throw listing the layers; throw if it
   *     is `writable: false`.
   *   - otherwise exactly one writable layer: that one.
   *   - zero writable layers: throw (every layer is read-only here).
   *   - several writable layers: throw — ambiguous; the caller must pass
   *     `--store <name>`. A silently-guessed store is how team knowledge leaks
   *     into the personal store and vice versa.
   *
   * Never creates anything; callers `init()` the returned layer's store
   * themselves if they want the skeleton (`question` deliberately does not).
   */
  static resolveWritable(cwd?: string, storeName?: string): WritableResolution {
    const { composite, via } = CompositeStore.resolveLayered(cwd);
    const where = composite.declaredIn ?? `${composite.root} (no stores: block)`;
    const describe = (l: StoreLayer) => `${l.name}${l.writable ? '' : ' (read-only)'}`;

    let target: StoreLayer | undefined;
    if (storeName) {
      target = composite.layers.find((l) => l.name === storeName);
      if (!target) {
        throw new Error(
          `no layer named '${storeName}' in ${where} (have: ${composite.layers.map(describe).join(', ')})`,
        );
      }
      if (!target.writable) {
        throw new Error(
          `layer '${target.name}' is not writable (writable: false, ${target.store.root}); ` +
            'read-only layers refuse remember/observe/question writes',
        );
      }
      return { layer: target, composite, via };
    }

    const writable = composite.layers.filter((l) => l.writable);
    if (writable.length === 1) return { layer: writable[0], composite, via };
    if (writable.length === 0) {
      throw new Error(
        `no writable store layer in scope: ${where} declares only read-only layers ` +
          `(${composite.layers.map(describe).join(', ')})`,
      );
    }
    throw new Error(
      `ambiguous write target: ${writable.length} writable layers in scope (${writable.map((s) => s.name).join(', ')}) — ` +
        'pass --store <name> to say where this memory belongs',
    );
  }

  /** #45 — convenience over `resolveWritable`: the store a write from `cwd` targets. */
  /**
   * `resolveWritable` plus the two defaults every plain write command shares
   * (`remember`, `observe`, and anything else that takes `--store`):
   *
   * - `legacyGlobal`: the caller already pointed `cwd` at the home store for
   *   `--store global`; when that store declares no layer literally named
   *   `global`, the name is dropped and the home store's own writable layer
   *   receives the write.
   * - No name, several writable layers, and the layer set came from the
   *   walked-up store's OWN config.yaml `stores:` block (the documented default
   *   declares `project` + `global`, both writable): default to the layer that
   *   IS the declaring store — where every pre-0.11 write landed, and a layer
   *   of the read view for this cwd. A pointer-file repo keeps the strict rule.
   *
   * One resolver for every write so `observe` cannot drift from `remember`
   * again (0.11 gate finding: observe still built `new MemspecStore(cwd)`).
   */
  static resolveWritableWithDefaults(cwd?: string, storeName?: string, legacyGlobal = false): WritableResolution {
    const layered = CompositeStore.forCwd(cwd);
    let name = storeName;
    if (name === 'global' && legacyGlobal && !layered.getLayer('global')) {
      name = undefined;
    }
    if (!name && layered.declaredIn && basename(layered.declaredIn) === 'config.yaml') {
      const writableLayers = layered.layers.filter((l) => l.writable);
      if (writableLayers.length > 1) {
        const declaringRoot = resolve(dirname(layered.declaredIn));
        const own = writableLayers.find((l) => resolve(l.store.root) === declaringRoot);
        if (own) name = own.name;
      }
    }
    return CompositeStore.resolveWritable(cwd, name);
  }

  static writableFor(cwd?: string, storeName?: string): MemspecStore {
    return CompositeStore.resolveWritable(cwd, storeName).layer.store;
  }

  get exists(): boolean {
    return this.layers.some((l) => l.store.exists);
  }

  get root(): string {
    return this.primary.root;
  }

  /**
   * Per-file load warnings from every layer, preceded by one warning per
   * configured layer whose store directory is absent (#20) so callers that
   * already print `warnings` surface the missing layer without new wiring.
   */
  get warnings(): LoadWarning[] {
    const missing: LoadWarning[] = this.unavailableLayers().map((l) => ({
      file: l.path,
      reason:
        `store layer '${l.name}'${l.writable ? '' : ' (read-only)'} is not available at ${l.path}` +
        (this.declaredIn ? ` (declared in ${this.declaredIn})` : '') +
        '; its records are missing from this view',
    }));
    return [...missing, ...this.layers.flatMap((l) => l.store.warnings)];
  }

  /**
   * Stamp `layer: <name>` on a record served from a NON-primary layer so a
   * caller can see which store a hit came from. Records from the primary
   * (writable) layer are returned untouched, keeping single-store retrieval
   * byte-identical. The annotation is read-time only — `serializeMemoryFile`
   * never persists it — so callers that read-modify-write a record must fetch
   * it from the owning layer's own store, not from this stamped view.
   */
  private stampLayer(item: MemoryItem, layer: StoreLayer): MemoryItem {
    return layer.store === this.primary ? item : { ...item, layer: layer.name };
  }

  /**
   * Cross-layer supersession: active records in a writable layer whose
   * `supersedes` names a record that lives (active) in a read-only layer,
   * keyed by that target id. First writable layer (priority order) wins when
   * two local records claim the same target.
   *
   * Why the read view has to honour this: a read-only layer (a team store
   * bound by path) can only be corrected through a PR to its own repo. Until
   * that PR lands, a local correction sits beside the original and the
   * original keeps ranking as active — an agent then repeats the very claim
   * that was corrected. Reading the local `supersedes` edge as authoritative
   * for THIS view closes that gap without touching the read-only files.
   *
   * Empty (and free) unless the view has both a read-only and a writable
   * layer on disk, so single-store retrieval is unaffected. The claim is
   * carried by the live end of the local record's `superseded_by` chain
   * (`liveEndOfChain`): an active record holds it, a local correction of it
   * inherits it, and a chain ending retired withdraws it.
   */
  pendingPromotions(): Map<string, PendingPromotion> {
    const out = new Map<string, PendingPromotion>();
    const present = this.layers.filter((l) => l.store.exists);
    const readOnly = present.filter((l) => !l.writable);
    const writable = present.filter((l) => l.writable);
    if (readOnly.length === 0 || writable.length === 0) return out;

    const readOnlyOwner = new Map<string, string>();
    for (const layer of readOnly) {
      for (const item of layer.store.loadActive()) {
        if (!readOnlyOwner.has(item.id)) readOnlyOwner.set(item.id, layer.name);
      }
    }
    const local = new Map<string, MemoryItem>();
    for (const layer of writable) {
      for (const item of layer.store.loadAll()) {
        if (!local.has(item.id)) local.set(item.id, item);
      }
    }
    for (const item of local.values()) {
      for (const targetId of item.supersedes ?? []) {
        const targetLayer = readOnlyOwner.get(targetId);
        if (!targetLayer || out.has(targetId)) continue;
        const live = liveEndOfChain(item, local);
        if (live) out.set(targetId, { id: live.id, target_id: targetId, target_layer: targetLayer });
      }
    }
    return out;
  }

  /**
   * Load all items from all layers. A read-only-layer record superseded in
   * this view (see `pendingPromotions`) is served as `superseded`, with
   * `superseded_by` naming the local record and `superseded_in_view: true`.
   */
  loadAll(): MemoryItem[] {
    const pending = this.pendingPromotions();
    const allItems: MemoryItem[] = [];
    for (const layer of this.layers) {
      if (layer.store.exists) {
        allItems.push(...layer.store.loadAll().map((item) => this.markSupersededInView(this.stampLayer(item, layer), layer, pending)));
      }
    }
    return allItems;
  }

  /** The `loadAll` projection of one record under cross-layer supersession; identity for everything else. */
  private markSupersededInView(item: MemoryItem, layer: StoreLayer, pending: ReadonlyMap<string, PendingPromotion>): MemoryItem {
    if (layer.writable || item.state !== 'active') return item;
    const promotion = pending.get(item.id);
    if (!promotion) return item;
    return { ...item, state: 'superseded', superseded_by: promotion.id, superseded_in_view: true };
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
          items.push(this.stampLayer(item, layer));
        }
      }
    }
    // Records superseded only in this view, so a walk along a local record's
    // `supersedes` edge can still reach the read-only original.
    const pending = this.pendingPromotions();
    if (pending.size > 0) {
      for (const item of this.loadAll()) {
        if (item.superseded_in_view && !seen.has(item.id)) {
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
    const pending = this.pendingPromotions();

    // Layers are sorted by priority desc, so higher priority items get added first
    for (const layer of this.layers) {
      if (!layer.store.exists) continue;
      for (const item of layer.store.loadActive()) {
        if (!seen.has(item.id)) {
          seen.add(item.id);
          // Superseded in this view by a local record: not active here.
          if (!layer.writable && pending.has(item.id)) continue;
          items.push(this.stampLayer(item, layer));
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
    if (active.length === 1) {
      return active[0].store.search(query, options, meta).map((item) => this.stampLayer(item, active[0]));
    }

    // Over-fetch so fusion has material below the caller's cut.
    const perLayerLimit = Math.max(limit * 2, 20);
    // Read-only-layer records a local record supersedes are dropped before the
    // cut, so they cannot crowd out the hits the caller should see.
    const pending = this.pendingPromotions();

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
        if (!layer.writable && pending.has(item.id)) return;
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
            item: this.stampLayer(item, layer),
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

  /** Find by ID across all layers (highest priority first), layer-stamped. */
  findById(id: string): MemoryItem | null {
    for (const layer of this.layers) {
      if (!layer.store.exists) continue;
      const item = layer.store.findById(id);
      if (item) return this.stampLayer(item, layer);
    }
    return null;
  }

  /**
   * The layer that owns `id` (highest priority first), or null when no layer
   * holds it. Unlike `findById`, this returns the layer itself so mutation
   * commands can check its `writable` flag before writing.
   */
  layerForId(id: string): StoreLayer | null {
    for (const layer of this.layers) {
      if (!layer.store.exists) continue;
      if (layer.store.findById(id)) return layer;
    }
    return null;
  }

  /**
   * Resolve the layer a mutation of `id` must target, enforcing read-only
   * layers. Returns null when no layer holds the record (the caller then
   * surfaces its own not-found error). Throws — naming the layer — when the
   * record lives in a `writable: false` layer: an in-place edit (supersede,
   * relate, unrelate, verify, anchor) to a read-only store is refused the same
   * way `writeItem` refuses a read-only write target.
   */
  assertWritableLayerForId(id: string): StoreLayer | null {
    const layer = this.layerForId(id);
    if (!layer) return null;
    if (!layer.writable) {
      throw new Error(
        `"${id}" lives in read-only store layer '${layer.name}' (${layer.store.root}); ` +
          'it cannot be modified here. Read-only layers refuse remember/observe/supersede/relate/unrelate/verify/anchor.',
      );
    }
    return layer;
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
