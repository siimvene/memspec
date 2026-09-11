import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemspecStore } from '../src/lib/store.js';
import { loadConfig } from '../src/lib/config.js';
import { resolveScopeForCwd } from '../src/lib/scope.js';

/**
 * C1 — upward walk for store resolution. Before C1, `new MemspecStore(cwd)`
 * resolved literally to `<cwd>/.memspec`, so a session in a subdirectory (or a
 * repo with no store of its own) got a phantom empty store instead of the real
 * one up the tree. The walk is fenced: it never climbs above $HOME, never walks
 * when cwd is outside $HOME, and is disabled by MEMSPEC_NO_WALK=1.
 */

/**
 * Run `body` with $HOME redirected to a throwaway directory so the walk's
 * upper bound is a temp tree we control, never the operator's real home.
 */
function withFakeHome<T>(body: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), 'memspec-home-'));
  const original = process.env.HOME;
  const originalNoWalk = process.env.MEMSPEC_NO_WALK;
  process.env.HOME = home;
  delete process.env.MEMSPEC_NO_WALK;
  try {
    return body(home);
  } finally {
    if (original === undefined) delete process.env.HOME;
    else process.env.HOME = original;
    if (originalNoWalk === undefined) delete process.env.MEMSPEC_NO_WALK;
    else process.env.MEMSPEC_NO_WALK = originalNoWalk;
  }
}

function makeStore(dir: string): void {
  mkdirSync(join(dir, '.memspec'), { recursive: true });
}

test('C1: a subdirectory resolves the parent repo store, not a phantom', () => {
  withFakeHome((home) => {
    const repo = join(home, 'repo');
    const sub = join(repo, 'src', 'deep');
    mkdirSync(sub, { recursive: true });
    makeStore(repo);

    assert.equal(new MemspecStore(sub).root, join(repo, '.memspec'));
  });
});

test('C1: the walk stops at $HOME (inclusive)', () => {
  withFakeHome((home) => {
    makeStore(home); // the only store in the tree lives at $HOME
    const deep = join(home, 'a', 'b', 'c');
    mkdirSync(deep, { recursive: true });

    assert.equal(new MemspecStore(deep).root, join(home, '.memspec'));
  });
});

test('C1: no store anywhere in $HOME falls back to <cwd>/.memspec (never climbs above $HOME)', () => {
  withFakeHome((home) => {
    const deep = join(home, 'x', 'y');
    mkdirSync(deep, { recursive: true });
    // No .memspec anywhere under (or at) $HOME → phantom fallback, proving the
    // walk did not escape $HOME to find some ancestor store.
    assert.equal(new MemspecStore(deep).root, join(deep, '.memspec'));
  });
});

test('C1: a cwd outside $HOME does not walk (cwd-only, as before)', () => {
  withFakeHome(() => {
    const outside = mkdtempSync(join(tmpdir(), 'memspec-outside-'));
    makeStore(outside);
    const sub = join(outside, 'nested');
    mkdirSync(sub, { recursive: true });
    // `outside` is a sibling of the fake $HOME, not under it → no walk, even
    // though `outside/.memspec` exists one level up.
    assert.equal(new MemspecStore(sub).root, join(sub, '.memspec'));
  });
});

test('C1: MEMSPEC_NO_WALK=1 restores the pre-C1 phantom-store behaviour', () => {
  withFakeHome((home) => {
    const repo = join(home, 'repo');
    const sub = join(repo, 'src');
    mkdirSync(sub, { recursive: true });
    makeStore(repo);

    process.env.MEMSPEC_NO_WALK = '1';
    assert.equal(new MemspecStore(sub).root, join(sub, '.memspec'));
  });
});

test('C1: an explicit .memspec dir is used as-is even from within $HOME (idempotent)', () => {
  withFakeHome((home) => {
    const store = join(home, 'repo', '.memspec');
    mkdirSync(store, { recursive: true });
    assert.equal(new MemspecStore(store).root, store);
  });
});

test('C1: store resolves from the walk, scope from the ORIGINAL cwd', () => {
  withFakeHome((home) => {
    const repo = join(home, 'proj');
    const sub = join(repo, 'service', 'api');
    mkdirSync(sub, { recursive: true });
    mkdirSync(join(repo, '.memspec'), { recursive: true });
    writeFileSync(
      join(repo, '.memspec', 'config.yaml'),
      `scopes:\n  alpha: ['${sub}']\n`,
    );

    // Store is the parent repo's store (found by walking up from the subdir)...
    const store = new MemspecStore(sub);
    assert.equal(store.root, join(repo, '.memspec'));

    // ...but the active scope is derived from the ORIGINAL cwd, so a session in
    // repo/service/api is scoped `alpha`, not left unscoped.
    const scope = resolveScopeForCwd(loadConfig(store.root).scopes, sub);
    assert.equal(scope, 'alpha');
  });
});
