import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MemspecStore } from '../src/lib/store.js';
import { CompositeStore } from '../src/lib/composite-store.js';
import { findPointer } from '../src/lib/registry.js';
import { loadConfig } from '../src/lib/config.js';
import { resolveScopeForCwd } from '../src/lib/scope.js';

/**
 * C1 — upward walk for store resolution. Before C1, `new MemspecStore(cwd)`
 * resolved literally to `<cwd>/.memspec`, so a session in a subdirectory (or a
 * repo with no store of its own) got a phantom empty store instead of the real
 * one up the tree. The walk is fenced: it never climbs above $HOME when cwd is
 * inside $HOME, walks to the filesystem root when cwd is outside $HOME (the
 * pre-0.11 behaviour), and is disabled by MEMSPEC_NO_WALK=1. The `.memspec.yaml`
 * pointer walk shares the same fence.
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

test('C1/#4: a cwd outside $HOME walks to the filesystem root (main behaviour restored)', () => {
  withFakeHome(() => {
    const outside = mkdtempSync(join(tmpdir(), 'memspec-outside-'));
    makeStore(outside);
    const sub = join(outside, 'nested', 'deeper');
    mkdirSync(sub, { recursive: true });
    // `outside` is a sibling of the fake $HOME, not under it. Pre-0.11
    // `findRoot()` walked to `/` from anywhere; the 0.11 pre-release fenced
    // outside-$HOME cwds to "cwd only", so /srv/app/src got a phantom store.
    assert.equal(new MemspecStore(sub).root, join(outside, '.memspec'));
  });
});

test('#7/#14/#35: pointer walk honours MEMSPEC_NO_WALK=1 (cwd only)', () => {
  withFakeHome((home) => {
    const repo = join(home, 'repo');
    const sub = join(repo, 'src');
    mkdirSync(sub, { recursive: true });
    const target = join(home, 'target', '.memspec');
    mkdirSync(target, { recursive: true });
    writeFileSync(
      join(repo, '.memspec.yaml'),
      `stores:\n  - name: t\n    path: ${target}\n    priority: 10\n    writable: true\n`,
    );
    assert.ok(findPointer(sub), 'sanity: pointer found from the subdirectory when the walk is on');

    process.env.MEMSPEC_NO_WALK = '1';
    assert.equal(findPointer(sub), null, 'no walk: the pointer one level up is not consulted');
    // ...but a pointer AT cwd still applies (cwd itself is always checked).
    assert.ok(findPointer(repo));
    // search (forCwd) and status (MemspecStore) now agree on the store.
    assert.equal(CompositeStore.forCwd(sub).root, new MemspecStore(sub).root);
  });
});

test('#7: pointer walk stops at $HOME — a pointer above $HOME never redirects', () => {
  withFakeHome((home) => {
    const above = dirname(home); // the temp dir that holds the fake $HOME
    const evil = join(home, 'evil', '.memspec');
    mkdirSync(evil, { recursive: true });
    const pointer = join(above, '.memspec.yaml');
    writeFileSync(pointer, `stores:\n  - name: attacker\n    path: ${evil}\n    priority: 10\n    writable: true\n`);
    try {
      const deep = join(home, 'a', 'b');
      mkdirSync(deep, { recursive: true });
      assert.equal(findPointer(deep), null);
      assert.equal(CompositeStore.forCwd(deep).root, join(deep, '.memspec'), 'falls back to the classic path, not the attacker store');
    } finally {
      unlinkSync(pointer);
    }
  });
});

test('#7: outside $HOME the pointer walk climbs like the store walk, but a pointer in a world-writable dir is refused', () => {
  withFakeHome(() => {
    const base = mkdtempSync(join(tmpdir(), 'memspec-ptr-'));
    const target = join(base, 'target', '.memspec');
    mkdirSync(target, { recursive: true });
    const decl = `stores:\n  - name: t\n    path: ${target}\n    priority: 10\n    writable: true\n`;

    // Trusted: operator-owned, mode 0700 (mkdtemp) — found from a subdirectory.
    const repo = join(base, 'repo');
    mkdirSync(join(repo, 'src', 'deep'), { recursive: true });
    writeFileSync(join(repo, '.memspec.yaml'), decl);
    assert.equal(findPointer(join(repo, 'src', 'deep'))?.dir, repo);

    // Untrusted: same file in a /tmp-style world-writable (sticky) directory.
    const shared = join(base, 'shared');
    mkdirSync(join(shared, 'victim', 'deep'), { recursive: true });
    writeFileSync(join(shared, '.memspec.yaml'), decl);
    chmodSync(shared, 0o1777);
    if (typeof process.getuid === 'function') {
      assert.equal(findPointer(join(shared, 'victim', 'deep')), null, 'a pointer anyone could have planted never redirects');
    }
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

test('C1: a nearer .memspec/ dir beats a farther .memspec.yaml pointer', () => {
  withFakeHome((home) => {
    const proj = join(home, 'proj');
    const sub = join(proj, 'service');
    const deep = join(sub, 'src');
    mkdirSync(deep, { recursive: true });

    // Farther up: a pointer file that would route resolution elsewhere.
    const elsewhere = join(home, 'elsewhere', '.memspec');
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(
      join(proj, '.memspec.yaml'),
      `stores:\n  - name: elsewhere\n    path: ${elsewhere}\n    priority: 0\n    writable: true\n`,
    );
    // Nearer: a real store directory between cwd and the pointer.
    mkdirSync(join(sub, '.memspec'), { recursive: true });

    // forCwd (the pointer-aware entry point) must resolve the nearer store dir
    // and never consult the ancestor pointer.
    const composite = CompositeStore.forCwd(deep);
    assert.equal(composite.root, join(sub, '.memspec'));
    assert.equal(composite.layers.length, 1, 'nearer store is a single unlayered store, not the pointer layers');
  });
});
