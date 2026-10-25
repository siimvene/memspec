import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runRemember } from '../src/commands/remember.js';
import { runVerify } from '../src/commands/verify.js';
import { blobSha } from '../src/lib/anchors.js';
import { MemspecStore } from '../src/lib/store.js';
import { McpSession } from './mcp-session.js';
import { makeTempProject, REPO_ROOT, runCli } from './helpers.js';

/**
 * verify --reanchor: the caller asserts a drifted claim still holds against
 * the changed code. Changed anchors move to the current blob, the previous
 * shas go to ext.anchor_history, last_verified refreshes. Without the flag a
 * drifted anchor still returns needs_review and nothing is written.
 */

async function anchoredClaim(): Promise<{ cwd: string; id: string; file: string; oldSha: string }> {
  const cwd = await makeTempProject();
  await runCli(['init', '--cwd', cwd]);
  mkdirSync(join(cwd, 'src'));
  const file = join(cwd, 'src', 'limits.ts');
  writeFileSync(file, 'export const MAX_UPLOAD_MB = 5;\n');
  const rec = runRemember('fact', 'Uploads are capped at 5 MB', { cwd, body: 'MAX_UPLOAD_MB', source: 'agent-a', anchors: ['src/limits.ts'] });
  return { cwd, id: rec.id, file, oldSha: rec.anchors[0].sha };
}

function record(cwd: string, id: string) {
  return new MemspecStore(cwd).findById(id)!;
}

test('without --reanchor a changed anchor returns needs_review, names the reanchor path, and writes nothing', async () => {
  const { cwd, id, file, oldSha } = await anchoredClaim();
  writeFileSync(file, '// refactor\nexport const MAX_UPLOAD_MB = 5;\n');
  const before = record(cwd, id);
  const result = runVerify(id, { cwd, evidence: 'checked' });
  assert.equal(result.status, 'needs_review');
  assert.match(result.message, new RegExp(`memspec verify ${id} --reanchor --evidence`));
  const after = record(cwd, id);
  assert.equal(after.anchors![0].sha, oldSha);
  assert.equal(after.last_verified, before.last_verified);
  assert.equal(after.ext?.anchor_history, undefined);
});

test('--reanchor requires evidence of what was checked', async () => {
  const { cwd, id, file, oldSha } = await anchoredClaim();
  writeFileSync(file, '// refactor\nexport const MAX_UPLOAD_MB = 5;\n');
  assert.throws(() => runVerify(id, { cwd, reanchor: true }), /--reanchor would re-baseline 1 changed anchor.*--evidence/);
  assert.equal(record(cwd, id).anchors![0].sha, oldSha);
});

test('--reanchor re-baselines the changed anchor, keeps the old sha in history, refreshes last_verified', async () => {
  const { cwd, id, file, oldSha } = await anchoredClaim();
  writeFileSync(file, '// refactor\nexport const MAX_UPLOAD_MB = 5;\n');
  const newSha = blobSha(file)!;
  const before = record(cwd, id);

  const result = runVerify(id, { cwd, reanchor: true, evidence: 'cap still 5 MB after the refactor', source: 'agent-b' });
  assert.equal(result.status, 'verified');
  assert.deepEqual(result.reanchored, [{ file: 'src/limits.ts', previous_sha: oldSha, sha: newSha }]);
  assert.match(result.message, /1 re-anchored on the caller's word/);

  const after = record(cwd, id);
  assert.equal(after.anchors![0].sha, newSha);
  assert.equal(after.verified_with, 'anchor');
  assert.notEqual(after.last_verified, before.last_verified);
  const history = after.ext?.anchor_history as Array<Record<string, unknown>>;
  assert.equal(history.length, 1);
  assert.equal(history[0].source, 'agent-b');
  assert.equal(history[0].evidence, 'cap still 5 MB after the refactor');
  assert.deepEqual(history[0].anchors, [{ file: 'src/limits.ts', previous_sha: oldSha, sha: newSha }]);

  // The re-baselined anchor now holds without the flag.
  assert.equal(runVerify(id, { cwd }).status, 'verified');

  // A second re-baseline appends; history is never overwritten.
  writeFileSync(file, '// refactor 2\nexport const MAX_UPLOAD_MB = 5;\n');
  runVerify(id, { cwd, reanchor: true, evidence: 'still 5 MB' });
  const history2 = record(cwd, id).ext?.anchor_history as Array<{ anchors: Array<{ previous_sha: string }> }>;
  assert.equal(history2.length, 2);
  assert.equal(history2[1].anchors[0].previous_sha, newSha);
});

test('--reanchor on unchanged anchors is a plain verify (no history entry)', async () => {
  const { cwd, id } = await anchoredClaim();
  const result = runVerify(id, { cwd, reanchor: true });
  assert.equal(result.status, 'verified');
  assert.equal(result.reanchored, undefined);
  assert.equal(record(cwd, id).ext?.anchor_history, undefined);
});

test('--reanchor cannot re-baseline a missing file: needs_review, untouched', async () => {
  const { cwd, id, file, oldSha } = await anchoredClaim();
  rmSync(file);
  const result = runVerify(id, { cwd, reanchor: true, evidence: 'x' });
  assert.equal(result.status, 'needs_review');
  assert.match(result.message, /--reanchor re-baselines changed files only/);
  assert.equal(record(cwd, id).anchors![0].sha, oldSha);
});

test('CLI and MCP wiring: --reanchor / reanchor: true', async () => {
  const { cwd, id, file } = await anchoredClaim();
  writeFileSync(file, '// refactor\nexport const MAX_UPLOAD_MB = 5;\n');
  const { stdout } = await runCli(['verify', id, '--cwd', cwd, '--reanchor', '--evidence', 'checked the constant']);
  assert.match(stdout, /re-anchored on the caller's word/);

  writeFileSync(file, '// refactor 2\nexport const MAX_UPLOAD_MB = 5;\n');
  const session = new McpSession([join(REPO_ROOT, 'src/mcp.ts'), '--cwd', cwd]);
  try {
    await session.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'memspec-test', version: '0.0.0' },
    });
    session.notify('notifications/initialized', {});
    const call = await session.request('tools/call', {
      name: 'memspec_verify',
      arguments: { id, reanchor: true, evidence: 'checked the constant again' },
    });
    const result = call.result as { isError?: boolean; structuredContent: { status: string; reanchored?: unknown[] } };
    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent.status, 'verified');
    assert.equal(result.structuredContent.reanchored?.length, 1);
  } finally {
    await session.close();
  }
  assert.equal((record(cwd, id).ext?.anchor_history as unknown[]).length, 2);
});
