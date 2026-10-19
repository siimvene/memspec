import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { parseYamlDocument } from './safe-matter.js';
import type { StoreLayerConfig } from './config.js';

/**
 * Store registry + scope claims — the anti-pollination layer.
 *
 * Two declarations, read from two directions:
 *
 * 1. A repo WITHOUT its own store can carry a `.memspec.yaml` pointer file at
 *    its root declaring which store layers serve it (same `stores:` schema as
 *    config.yaml, paths resolved against the pointer file's directory). This
 *    is how a PLG service repo binds to its team's `*-team-specs` store while
 *    keeping the personal store as a read layer. A `.memspec/` directory
 *    closer to cwd always wins over a pointer file.
 *
 * 2. A store's own config.yaml can declare `claims:` — path patterns for the
 *    working directories whose knowledge it owns (`~/git/kleidia`,
 *    `~/piletilevi/**`). Routing (e.g. `memspec reduce`) sends content to the
 *    claiming store; content nobody claims stays local rather than crossing a
 *    sync boundary by default.
 */

export interface PointerResolution {
  /** Directory containing the .memspec.yaml pointer file. */
  dir: string;
  stores: StoreLayerConfig[];
}

export const POINTER_FILENAME = '.memspec.yaml';

/** True when `dir` is the home directory or a descendant of it. */
function isWithinHome(dir: string): boolean {
  const home = resolve(homedir());
  const target = resolve(dir);
  return target === home || target.startsWith(home + sep);
}

/**
 * C1 — the ONE fenced upward walk shared by store-dir resolution
 * (`findStoreDirUpward`) and pointer resolution (`findPointer`). Both walks
 * must agree on where they stop, or `search` (pointer-aware) and `status`
 * (store-dir only) resolve different stores from the same cwd.
 *
 * Fence, in order:
 *
 *   - `MEMSPEC_NO_WALK=1`: no climb at all — only `startDir` is visited.
 *   - `startDir` inside $HOME: climb and stop AFTER visiting `$HOME`
 *     (inclusive). Nothing above the operator's home is ever consulted.
 *   - `startDir` outside $HOME: climb to the filesystem root, which is what
 *     `MemspecStore.findRoot()` did before 0.11 (`while (dir !== '/')`). A repo
 *     at /srv/app or in a container's /work has no $HOME to stop at, and
 *     fencing it to "cwd only" turned every subdirectory session into a
 *     phantom `<cwd>/.memspec` (0.11 pre-release regression).
 *
 * `visit` returns a value to stop the walk (the first non-undefined result is
 * returned) or `undefined` to keep climbing.
 */
export function walkUpFenced<T>(startDir: string, visit: (dir: string) => T | undefined): T | null {
  let dir = resolve(startDir);
  const noWalk = process.env.MEMSPEC_NO_WALK === '1';
  const home = resolve(homedir());
  const stopAtHome = isWithinHome(dir);

  while (true) {
    const hit = visit(dir);
    if (hit !== undefined) return hit;
    if (noWalk) return null;
    if (stopAtHome && dir === home) return null; // $HOME visited (inclusive); never above it
    const parent = dirname(dir);
    if (parent === dir) return null; // filesystem root visited
    dir = parent;
  }
}

function isStoreDir(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * C1 — bounded upward walk for a `.memspec/` store directory. Starting at
 * `startDir`, climb parent directories (see `walkUpFenced` for the fence) and
 * return the first `.memspec/` found. Returns null when nothing is found
 * within the fence — callers fall back to the classic `<startDir>/.memspec`.
 *
 * Only `.memspec/` directories resolve here; `.memspec.yaml` pointer files are
 * a separate, explicit repo-binding mechanism handled by `findPointer` /
 * `CompositeStore.forCwd`.
 */
export function findStoreDirUpward(startDir: string): string | null {
  return walkUpFenced(startDir, (dir) => {
    const candidate = join(dir, '.memspec');
    return isStoreDir(candidate) ? candidate : undefined;
  });
}

/**
 * A pointer REDIRECTS reads and writes to whatever path its author declared,
 * so unlike a `.memspec/` directory (where the store is visibly where you
 * are), the file itself has to be trusted. Refuse a pointer that
 *
 *   - lives in a world-writable directory (`/tmp`, `/private/tmp`, a shared
 *     scratch dir): anyone on the machine could have planted it;
 *   - lives in a directory writable by a group other than the caller's own
 *     (a shared project group could plant it just as well); or
 *   - is owned by a different user than the one running memspec.
 *
 * POSIX only — on platforms without `process.getuid` every pointer is trusted.
 * A refused pointer is reported once on stderr and otherwise treated as
 * absent, so resolution falls through to the classic path instead of failing.
 */
function pointerIsTrusted(file: string, dir: string): boolean {
  const getuid = process.getuid;
  if (typeof getuid !== 'function') return true;
  try {
    const uid = getuid();
    const dirStat = statSync(dir);
    const fileStat = statSync(file);
    const reasons: string[] = [];
    if ((dirStat.mode & 0o002) !== 0) reasons.push('its directory is world-writable');
    const getgid = process.getgid;
    if ((dirStat.mode & 0o020) !== 0 && typeof getgid === 'function' && dirStat.gid !== getgid()) {
      reasons.push(`its directory is writable by group ${dirStat.gid}, not the caller's group`);
    }
    if (fileStat.uid !== uid) reasons.push(`it is owned by uid ${fileStat.uid}, not ${uid}`);
    if (dirStat.uid !== uid) reasons.push(`its directory is owned by uid ${dirStat.uid}, not ${uid}`);
    if (reasons.length === 0) return true;
    if (!warnedPointers.has(file)) {
      warnedPointers.add(file);
      process.stderr.write(`memspec: ignoring untrusted ${POINTER_FILENAME} at ${file} (${reasons.join('; ')})\n`);
    }
    return false;
  } catch {
    return false;
  }
}
const warnedPointers = new Set<string>();

/**
 * Walk up from cwd (same fence as `findStoreDirUpward`: `MEMSPEC_NO_WALK=1`
 * → cwd only; inside $HOME → stop at $HOME; outside $HOME → filesystem root).
 * At each level a `.memspec/` store directory wins; a trusted `.memspec.yaml`
 * pointer file at a level with no store directory resolves to its declared
 * layers. Returns null when a real store (or nothing) is found — callers then
 * use the classic resolution path.
 */
export function findPointer(cwd?: string): PointerResolution | null {
  return walkUpFenced(cwd ?? process.cwd(), (dir): PointerResolution | null | undefined => {
    if (isStoreDir(join(dir, '.memspec'))) return null; // a real store here: pointer never consulted
    const pointer = join(dir, POINTER_FILENAME);
    if (!existsSync(pointer)) return undefined;
    if (!pointerIsTrusted(pointer, dir)) return undefined; // untrusted: as if absent, keep climbing
    const stores = parsePointer(pointer);
    if (stores.length > 0) return { dir, stores };
    return null; // malformed/empty pointer: fall back to classic resolution
  });
}

function parsePointer(file: string): StoreLayerConfig[] {
  try {
    const raw = readFileSync(file, 'utf8');
    const data = parseYamlDocument(raw);
    if (!Array.isArray(data.stores)) return [];
    return (data.stores as StoreLayerConfig[]).filter(
      (s) => typeof s?.name === 'string' && typeof s?.path === 'string'
    );
  } catch {
    return [];
  }
}

/** Expand ~ and resolve a layer path against the pointer/config directory. */
export function resolveLayerPath(path: string, baseDir: string): string {
  const expanded = path.startsWith('~') ? path.replace('~', homedir()) : path;
  return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
}

/**
 * Claim pattern matching. A pattern without wildcards claims that path and
 * everything under it. `*` matches within one path segment, `**` across
 * segments. `~` expands to the home directory.
 */
export function matchesClaim(patterns: string[], path: string): boolean {
  const target = resolve(path.startsWith('~') ? path.replace('~', homedir()) : path);
  for (const raw of patterns) {
    const pattern = resolve(raw.startsWith('~') ? raw.replace('~', homedir()) : raw);
    if (!/[*?]/.test(pattern)) {
      if (target === pattern || target.startsWith(pattern + '/')) return true;
      continue;
    }
    const regex = new RegExp(
      '^' +
        pattern
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*\*/g, '\x00')
          .replace(/\*/g, '[^/]*')
          .replace(/\?/g, '[^/]')
          .replace(/\x00/g, '.*') +
        '(/.*)?$'
    );
    if (regex.test(target)) return true;
  }
  return false;
}

/** Read the `claims:` list from a store root's config.yaml (empty when absent). */
export function claimsOf(storeRoot: string): string[] {
  try {
    const raw = readFileSync(join(storeRoot, 'config.yaml'), 'utf8');
    const claims = parseYamlDocument(raw).claims;
    return Array.isArray(claims) ? claims.filter((c): c is string => typeof c === 'string') : [];
  } catch {
    return [];
  }
}
