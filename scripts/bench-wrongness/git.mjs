// Read-only git plumbing over the (untrusted) replay repository. Nothing here
// runs code from that repository: only `git` itself, with hooks disabled.

import { execFileSync } from 'node:child_process';

const GIT_SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.file.allow=always'];

export function git(cwd, args, opts = {}) {
  // `encoding: 'buffer'` returns the raw Buffer (execFileSync's own default).
  return execFileSync('git', [...GIT_SAFE, ...args], {
    cwd,
    ...(opts.encoding === 'buffer' ? {} : { encoding: opts.encoding ?? 'utf8' }),
    maxBuffer: 1 << 30,
    stdio: ['pipe', 'pipe', 'pipe'],
    input: opts.input,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' },
  });
}

/** Paths of every blob in the tree at `commit`. */
export function lsTree(repo, commit) {
  return git(repo, ['ls-tree', '-r', '-z', '--name-only', commit]).split('\0').filter(Boolean);
}

/**
 * Contents of `paths` at `commit`, read in one `git cat-file --batch` call.
 * Returns Map path -> string (missing paths are absent).
 */
export function readFilesAt(repo, commit, paths) {
  const out = new Map();
  if (paths.length === 0) return out;
  const input = paths.map((p) => `${commit}:${p}`).join('\n') + '\n';
  const buf = git(repo, ['cat-file', '--batch'], { input, encoding: 'buffer' });
  let off = 0;
  for (const p of paths) {
    const nl = buf.indexOf(10, off);
    const header = buf.subarray(off, nl).toString('utf8');
    off = nl + 1;
    if (header.endsWith(' missing')) continue;
    const size = Number(header.split(' ')[2]);
    out.set(p, buf.subarray(off, off + size).toString('utf8'));
    off += size + 1;
  }
  return out;
}

/** Commits on the first-parent chain from `start` (exclusive) to `end` (inclusive), oldest first. */
export function firstParentRange(repo, start, end) {
  return git(repo, ['rev-list', '--first-parent', '--reverse', `${start}..${end}`]).split('\n').filter(Boolean);
}
