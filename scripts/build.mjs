#!/usr/bin/env node
// Crash-atomic, concurrent-safe build. Compile into a staging `dist.new`, then
// swap it into place with renames so a live MCP-server deployment under `dist/`
// (memspec-mcp resolves to `dist/mcp.js`) is never half-written. The old
// `clean && tsc` deleted `dist/` up front and rebuilt in place: a server
// starting during the seconds-long compile found an empty or partial tree.
//
// Guarantees:
//  - Concurrency: a `dist.lock` directory (atomic mkdir) makes two concurrent
//    builds abort rather than race. Released on every exit path.
//  - Crash recovery: if a previous run died mid-swap (dist/ gone, dist.old
//    present), dist.old is restored before anything else runs.
//  - Failure rollback: if the promote rename throws, dist.old is put back.
//
// The absence window is two renames (dist → dist.old, dist.new → dist), not the
// seconds of a compile; a process already running has its JS in memory and is
// unaffected, and a crash in that window is recovered on the next build.

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(repoRoot, 'dist');
const distNew = join(repoRoot, 'dist.new');
const distOld = join(repoRoot, 'dist.old');
const lock = join(repoRoot, 'dist.lock');
const tsc = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');

function isNonEmptyDir(p) {
  try {
    return readdirSync(p).length > 0;
  } catch {
    return false;
  }
}

// Concurrency guard: atomic mkdir. EEXIST means another build holds the lock.
try {
  mkdirSync(lock);
} catch (err) {
  if (err && err.code === 'EEXIST') {
    console.error(`build: another build holds ${lock}; aborting. Remove it if no build is running.`);
    process.exit(1);
  }
  throw err;
}

let released = false;
function releaseLock() {
  if (released) return;
  released = true;
  rmSync(lock, { recursive: true, force: true });
}
process.on('exit', releaseLock);

try {
  // Crash recovery FIRST: a prior run that died between the two swap renames
  // leaves dist/ absent and dist.old present. Restore before doing anything.
  if (!existsSync(dist) && existsSync(distOld)) {
    renameSync(distOld, dist);
    console.log('build: recovered dist/ from dist.old (previous run interrupted mid-swap)');
  }

  // Clean stale staging dirs from an aborted run.
  rmSync(distNew, { recursive: true, force: true });
  rmSync(distOld, { recursive: true, force: true });

  // Compile into the staging dir; dist/ stays intact and serving throughout.
  execFileSync(process.execPath, [tsc, '-p', 'tsconfig.json', '--outDir', distNew], {
    cwd: repoRoot,
    stdio: 'inherit',
  });

  // Never promote an empty compile over a working deployment.
  if (!isNonEmptyDir(distNew)) {
    throw new Error('build: compile produced an empty dist.new; refusing to swap');
  }

  // Executable bits before the swap, so the published tree is complete the
  // instant it becomes dist/.
  for (const f of ['cli.js', 'mcp.js']) {
    const p = join(distNew, f);
    if (existsSync(p)) chmodSync(p, 0o755);
  }

  // Swap. Move the current dist aside, then promote the new one. If the promote
  // fails, put the old tree back so we never leave dist/ missing.
  const hadDist = existsSync(dist);
  if (hadDist) renameSync(dist, distOld);
  try {
    renameSync(distNew, dist);
  } catch (err) {
    if (hadDist && !existsSync(dist) && existsSync(distOld)) renameSync(distOld, dist);
    throw err;
  }
  rmSync(distOld, { recursive: true, force: true });

  console.log('build: dist/ swapped in atomically');
} finally {
  releaseLock();
}
