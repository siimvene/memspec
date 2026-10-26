import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runRemember } from '../src/commands/remember.js';
import { claimIndexPath, loadClaimIndex } from '../src/lib/claim-index.js';
import { MemspecStore } from '../src/lib/store.js';
import { makeTempProject, runCli } from './helpers.js';

/**
 * The claim index is a derived, machine-local cache: the record files stay
 * canonical. A changed, added or removed file must show through on the next
 * call; a corrupt cache is rebuilt.
 */

async function store(): Promise<{ cwd: string; store: MemspecStore }> {
  const cwd = await makeTempProject();
  await runCli(['init', '--cwd', cwd]);
  return { cwd, store: new MemspecStore(cwd) };
}

test('builds under local/ (gitignored) and reflects every record', async () => {
  const { cwd, store: s } = await store();
  const a = runRemember('fact', 'Ledger rows are append-only', { cwd, body: 'No updates after insert.', source: 'agent-a' });
  const entries = loadClaimIndex(s);
  assert.ok(existsSync(claimIndexPath(s.root)));
  assert.ok(claimIndexPath(s.root).startsWith(join(s.root, 'local')));
  const entry = entries.find((e) => e.id === a.id)!;
  assert.equal(entry.state, 'active');
  assert.ok(entry.tokens.includes('ledger'));
});

test('a record changed on disk after the cache was built is re-read', async () => {
  const { cwd, store: s } = await store();
  const a = runRemember('fact', 'Ledger rows are append-only', { cwd, body: 'No updates after insert.', source: 'agent-a' });
  loadClaimIndex(s);
  const item = s.findById(a.id)!;
  s.updateItem({ ...item, body: `${item.body}\n\nInvoices reference ledger rows by id.` });
  const entry = loadClaimIndex(s).find((e) => e.id === a.id)!;
  assert.ok(entry.tokens.includes('invoic'), 'the edited body is visible');
});

test('a moved (archived) record shows its new state; a removed file drops out', async () => {
  const { cwd, store: s } = await store();
  const a = runRemember('fact', 'Ledger rows are append-only', { cwd, body: 'No updates after insert.', source: 'agent-a' });
  loadClaimIndex(s);
  const item = s.findById(a.id)!;
  s.moveToArchive({ ...item, superseded_by: undefined, supersede_reason: 'gone' }, 'superseded');
  const entries = loadClaimIndex(s);
  assert.equal(entries.filter((e) => e.id === a.id).length, 1);
  assert.equal(entries.find((e) => e.id === a.id)!.state, 'superseded');
  assert.equal(entries.find((e) => e.id === a.id)!.supersede_reason, 'gone');
});

test('a corrupt cache is rebuilt; an unparseable record is skipped', async () => {
  const { cwd, store: s } = await store();
  const a = runRemember('fact', 'Ledger rows are append-only', { cwd, body: 'No updates after insert.', source: 'agent-a' });
  loadClaimIndex(s);
  writeFileSync(claimIndexPath(s.root), '{not json');
  writeFileSync(join(s.root, 'memory', 'facts', 'broken.md'), '---\nid: nope\n---\n# Broken\n');
  const entries = loadClaimIndex(s);
  assert.deepEqual(entries.map((e) => e.id), [a.id]);
  assert.equal(JSON.parse(readFileSync(claimIndexPath(s.root), 'utf8')).version, 2);
  // Cached as invalid: still skipped on a cache hit.
  assert.deepEqual(loadClaimIndex(s).map((e) => e.id), [a.id]);
});
