import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { MemspecStore, type StoreSearchOptions, type LoadWarning } from './store.js';
import type { StoreLayerConfig } from './config.js';
import type { MemoryItem, MemoryFrontmatter } from './types.js';

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

  /** Search across all layers */
  search(query: string, options: StoreSearchOptions = {}): MemoryItem[] {
    const seen = new Set<string>();
    const allResults: MemoryItem[] = [];

    for (const layer of this.layers) {
      if (!layer.store.exists) continue;
      const results = layer.store.search(query, options);
      for (const item of results) {
        if (!seen.has(item.id)) {
          seen.add(item.id);
          allResults.push(item);
        }
      }
    }

    return allResults.slice(0, options.limit ?? 10);
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
