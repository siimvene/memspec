import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MemspecStore } from '../src/lib/store.js';

// Regression: MEMSPEC_ROOT pointed at the store dir itself (`~/.memspec`) used to
// double to `~/.memspec/.memspec`, so the MCP server read an empty phantom store
// while the CLI (`--store global` → homedir) read the real one. Resolution is now
// idempotent w.r.t. a trailing `.memspec` segment.

test('parent path appends .memspec', () => {
  const store = new MemspecStore('/tmp/project');
  assert.equal(store.root, join('/tmp/project', '.memspec'));
});

test('a path that already ends in .memspec is used as-is (no doubling)', () => {
  const store = new MemspecStore('/tmp/project/.memspec');
  assert.equal(store.root, '/tmp/project/.memspec');
});

test('CLI-global and MCP-MEMSPEC_ROOT resolve to the same global store', () => {
  const viaHomedir = new MemspecStore(homedir()); // CLI `--store global`
  const viaStoreDir = new MemspecStore(join(homedir(), '.memspec')); // MCP MEMSPEC_ROOT=~/.memspec
  assert.equal(viaHomedir.root, join(homedir(), '.memspec'));
  assert.equal(viaStoreDir.root, viaHomedir.root);
});
