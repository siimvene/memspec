import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, rmSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';

/** A lock older than this is a crashed writer's, and is reclaimed. Every locked section takes well under a second. */
export const LOCK_STALE_MS = 30_000;

export interface FileLockOptions {
  /**
   * How long to wait for a held lock before giving up, in ms. 0 (the default)
   * refuses at once. Waiting is a blocking sleep: memspec commands are
   * synchronous and one process runs one command at a time.
   */
  waitMs?: number;
  /** Error message used when the lock stays held. */
  busyMessage?: (path: string) => string;
}

const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));

function sleep(ms: number): void {
  Atomics.wait(SLEEP_CELL, 0, 0, ms);
}

/** File-name-safe form of a lock key. */
function lockName(key: string): string {
  return /^[A-Za-z0-9_-]{1,128}$/.test(key) ? key : createHash('sha1').update(key).digest('hex');
}

/**
 * Run `fn` holding an exclusive lock file in the store's machine-local subtree
 * (`local/locks/<key>.lock`, created with the `wx` flag, removed in
 * `finally`). Exclusive create is the only atomic primitive the store needs:
 * a check-then-write section (read a record or the claim index, decide,
 * write) run under the same key by two processes is serialized. A lock older
 * than `LOCK_STALE_MS` was left by a crashed writer and is reclaimed. Not
 * reentrant: a locked section must not take the same key again.
 */
export function withFileLock<T>(storeRoot: string, key: string, fn: () => T, options: FileLockOptions = {}): T {
  const dir = join(storeRoot, 'local', 'locks');
  const path = join(dir, `${lockName(key)}.lock`);
  mkdirSync(dir, { recursive: true });
  const busy = () => new Error(
    options.busyMessage?.(path) ??
      `another memspec write holds ${path}; retry in a moment, or delete the lock file if no memspec process is running`,
  );
  const acquire = (): number | null => {
    try {
      return openSync(path, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return null;
      throw err;
    }
  };
  // MEMSPEC_LOCK_WAIT_MS overrides a waiting lock's patience (slow disks, tests);
  // a lock that refuses at once (waitMs 0) keeps refusing at once.
  const envWait = process.env.MEMSPEC_LOCK_WAIT_MS?.trim() ? Number(process.env.MEMSPEC_LOCK_WAIT_MS) : Number.NaN;
  const waitMs = (options.waitMs ?? 0) > 0 && Number.isFinite(envWait) && envWait >= 0 ? envWait : options.waitMs ?? 0;
  const deadline = Date.now() + waitMs;
  let fd = acquire();
  while (fd === null) {
    let age = Number.POSITIVE_INFINITY;
    try {
      age = Date.now() - statSync(path).mtimeMs;
    } catch {
      // Released between our open and stat: retry below.
    }
    if (age >= LOCK_STALE_MS) {
      rmSync(path, { force: true });
    } else if (Date.now() >= deadline) {
      throw busy();
    } else {
      sleep(Math.min(25, Math.max(1, deadline - Date.now())));
    }
    fd = acquire();
    if (fd === null && age >= LOCK_STALE_MS && Date.now() >= deadline) throw busy();
  }
  try {
    writeSync(fd, `${process.pid}\n`);
  } finally {
    closeSync(fd);
  }
  try {
    return fn();
  } finally {
    rmSync(path, { force: true });
  }
}
