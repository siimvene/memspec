import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { anchorWithinBase, checkAnchors } from '../src/lib/anchors.js';

// M1: an anchor's file must stay inside its resolved base. Traversal, an
// absolute path elsewhere, or a symlink out is treated as unavailable — never
// followed to read whatever it points at.

test('anchorWithinBase accepts paths inside the base', async () => {
  const base = await mkdtemp(join(tmpdir(), 'memspec-contain-'));
  assert.equal(anchorWithinBase(base, 'src/x.ts'), true);
  assert.equal(anchorWithinBase(base, './a/b/c'), true);
});

test('anchorWithinBase rejects .. traversal and absolute escapes', async () => {
  const base = await mkdtemp(join(tmpdir(), 'memspec-contain-'));
  assert.equal(anchorWithinBase(base, '../escape'), false);
  assert.equal(anchorWithinBase(base, '../../etc/passwd'), false);
  assert.equal(anchorWithinBase(base, '/etc/passwd'), false);
});

test('anchorWithinBase rejects a symlink that points out of the base', async () => {
  const base = await mkdtemp(join(tmpdir(), 'memspec-contain-'));
  const outside = await mkdtemp(join(tmpdir(), 'memspec-outside-'));
  await writeFile(join(outside, 'secret.txt'), 'top secret\n');
  await symlink(outside, join(base, 'link'));
  // Lexically 'link/secret.txt' is under base, but realpath resolves out.
  assert.equal(anchorWithinBase(base, 'link/secret.txt'), false);
});

test('checkAnchors reports an escaping anchor as repo_unavailable, not unchanged', async () => {
  const base = await mkdtemp(join(tmpdir(), 'memspec-contain-'));
  const outside = await mkdtemp(join(tmpdir(), 'memspec-outside-'));
  await mkdir(join(base, 'link-parent'), { recursive: true });
  const secret = join(outside, 'secret.txt');
  await writeFile(secret, 'top secret\n');
  await symlink(outside, join(base, 'escape'));

  // Compute the blob sha the escaping file WOULD have, and hand it to the
  // anchor. If containment failed, checkAnchors would read the file, match the
  // sha, and report 'unchanged'. Containment must instead refuse to read it.
  const { createHash } = await import('node:crypto');
  const buf = Buffer.from('top secret\n');
  const sha = createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

  const [status] = checkAnchors(base, [{ file: 'escape/secret.txt', sha }]);
  assert.equal(status.status, 'repo_unavailable', 'escaping anchor is not witnessed');
  assert.notEqual(status.currentSha, sha, 'the outside file was never read');
});
