#!/usr/bin/env node
// Memspec Session Start Hook — SessionStart event
//
// Pushes the most relevant active memories into the agent's session-start
// context so the agent never has to remember to call memspec_search.
//
// Locates the memspec store by checking, in order:
//   1. $MEMSPEC_ROOT
//   2. <cwd>/.memspec
//   3. ancestors of cwd up to the user's home directory
//   4. ~/.memspec
//
// If no store is found or the CLI is unavailable, the hook is a graceful
// no-op (exit 0 with empty additionalContext). It must never block or
// confuse the session.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

function findMemspecRoot(cwd) {
  if (process.env.MEMSPEC_ROOT) {
    const candidate = process.env.MEMSPEC_ROOT;
    if (fs.existsSync(candidate)) return candidate;
  }

  const home = os.homedir();
  let dir = path.resolve(cwd || process.cwd());
  // Walk up to (and including) the home directory.
  while (true) {
    const candidate = path.join(dir, '.memspec');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    if (dir === home) break;
    dir = parent;
  }

  const homeCandidate = path.join(home, '.memspec');
  if (fs.existsSync(homeCandidate)) return homeCandidate;

  return null;
}

// Dream passes land in <store>/dream/YYYY-MM-DD.md with no review state.
// A file counts as reviewed when it contains a "_Reviewed:" line (added by
// the agent after the operator walks through it; git-synced stores keep the
// marker consistent across machines). Dream was originally a personal-store
// feature (the check always covers the home store regardless of which store
// won resolution), but a project/team store can now run its own dream pass
// too (v0.12 precursor) — see the dual-store call in runHook below, which
// additionally checks the resolved store's own dream/ dir when it differs
// from the home store.
//
// A file whose body carries a "_Status: FAILED" line (added by bin/dream when
// the underlying `claude` call failed, e.g. an expired OAuth session on the
// host that ran it) is a FAILED pass, not a pending-review one: the weekly
// analysis never ran, so there's nothing to review, only a runner to fix.
// FAILED files are reported separately and excluded from the pending list
// and its counts. Files with neither marker (older passes, or a fresh
// no-activity note) fall through to the pending-review path as before.
//
// `storeLabel` (e.g. "store: ~/.memspec" or "store: /path/to/project/.memspec")
// is folded into the section headers so a session with two active dream
// notices (home + project) can tell which is which.
function pendingDreamNotice(memspecRoot, storeLabel) {
  try {
    const dreamDir = path.join(memspecRoot, 'dream');
    if (!fs.existsSync(dreamDir)) return '';
    const files = fs
      .readdirSync(dreamDir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort()
      .map((f) => ({ name: f, body: fs.readFileSync(path.join(dreamDir, f), 'utf8') }));

    const failed = files.filter((d) => /^_Status: FAILED/m.test(d.body));
    const pending = files.filter(
      (d) => !/^_Status: FAILED/m.test(d.body) && !/^_?Reviewed:/im.test(d.body)
    );

    const parts = [];

    if (failed.length) {
      const latestFailed = failed[failed.length - 1];
      const reasonLine = (latestFailed.body.match(/^_Status: FAILED[^\n]*/m) || [''])[0]
        .replace(/^_Status: FAILED\s*—?\s*/, '')
        .replace(/_\s*$/, '')
        .trim();
      let failNotice = `## Dream pass FAILED (${storeLabel})\n\n${latestFailed.name.replace('.md', '')}: ${reasonLine || 'unknown error'}\nthe weekly pass did not run; fix the runner (claude login on the host that ran it) — see dream/${latestFailed.name}`;
      if (failed.length > 1) failNotice += `\n(${failed.length - 1} older FAILED pass(es) also unresolved.)`;
      parts.push(failNotice);
    }

    if (pending.length) {
      const latest = pending[pending.length - 1];
      const counts = [];
      for (const m of latest.body.matchAll(/^## +(.+)$/gm)) {
        const section = latest.body.slice(m.index + m[0].length).split(/^## /m)[0];
        const items = (section.match(/^- /gm) || []).length;
        if (items) counts.push(`${items} ${m[1].trim().toLowerCase()}`);
      }
      const questions = (latest.body.split(/^## OPEN QUESTIONS$/m)[1] || '')
        .split(/^## /m)[0]
        .split('\n')
        .filter((l) => l.startsWith('- '))
        .map((l) => l.replace(/\*\*/g, '').slice(2, 120));

      let notice = `## Dream pass pending review (${storeLabel})\n\n${latest.name.replace('.md', '')} (${counts.join(', ')}) at dream/${latest.name} — proposals only, nothing auto-applied. Offer to walk the operator through it; after review, prepend a "_Reviewed: <date> — <disposition summary>_" line under the title and commit.`;
      if (questions.length) notice += `\nOpen questions needing the operator: ${questions.join(' | ')}`;
      if (pending.length > 1) notice += `\n(${pending.length - 1} older unreviewed pass(es) also pending.)`;
      parts.push(notice);
    }

    return parts.join('\n\n');
  } catch {
    return '';
  }
}

// Surface actionable WARN lines from the machine claims-check at boot. All-PASS
// is silent (no noise). Never throws — a missing sibling script is a no-op.
function claimsCheckNotice() {
  try {
    const { runClaimsCheck } = require('./memspec-claims-check.js');
    const warns = runClaimsCheck().filter((l) => l.startsWith('WARN'));
    if (!warns.length) return '';
    return `## Enforcement claims-check\n\n${warns.map((w) => `- ${w}`).join('\n')}`;
  } catch {
    return '';
  }
}

function emit(additionalContext) {
  const result = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: additionalContext || '',
    },
  };
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}

let input = '';
const stdinTimeout = setTimeout(() => {
  // Stdin never closed — still try to do useful work using process cwd.
  try {
    runHook({});
  } catch (e) {
    emit('');
  }
}, 10000);

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);
  let data = {};
  try {
    data = input ? JSON.parse(input) : {};
  } catch {
    // ignore malformed input
  }
  runHook(data);
});


// Repo name for the cwd (git toplevel basename), sanitized to FTS-safe tokens; null outside a repo.
function repoTerm(cwd) {
  try {
    const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 2000 });
    if (r.status !== 0) return null;
    const name = path.basename(r.stdout.trim()).replace(/[^A-Za-z0-9_-]+/g, ' ').trim();
    return name || null;
  } catch {
    return null;
  }
}

// Active scope for `cwd`, resolved from the store's config.yaml `scopes:` block with the same
// semantics as memspec's matchesClaim (path prefix, or a * / ** glob). memspec 0.10.0 derives the
// scope from --cwd itself, but --cwd also selects the STORE, so the hook must pass the store's
// project root there and hand the scope over explicitly. Undefined = no scoping (byte-identical
// to pre-0.10.0 behaviour); only names declared in config are ever passed, so assertKnownScope
// cannot reject them.
function resolveScope(memspecRoot, cwd) {
  try {
    const home = os.homedir();
    const expand = (x) => path.resolve(x.startsWith('~') ? x.replace('~', home) : x);
    const target = expand(cwd);
    const lines = fs.readFileSync(path.join(memspecRoot, 'config.yaml'), 'utf8').split('\n');
    let inScopes = false, name = null;
    for (const line of lines) {
      if (/^scopes:\s*$/.test(line)) { inScopes = true; continue; }
      if (!inScopes) continue;
      if (/^\S/.test(line)) break; // next top-level key
      const nm = line.match(/^  ([A-Za-z0-9_-]+):\s*$/);
      if (nm) { name = nm[1]; continue; }
      const it = line.match(/^\s+-\s+(\S+)\s*$/);
      if (!it || !name) continue;
      const pattern = expand(it[1]);
      if (!/[*?]/.test(pattern)) {
        if (target === pattern || target.startsWith(pattern + '/')) return name;
        continue;
      }
      const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*') + '(/.*)?$');
      if (re.test(target)) return name;
    }
  } catch {
    /* no config or unreadable: unscoped */
  }
  return undefined;
}

// One `memspec context` run. Returns trimmed stdout, or null when the CLI failed.
function runContext(memspecRoot, projectRoot, extraArgs) {
  const child = spawnSync('memspec', ['context', '--format', 'markdown', '--cwd', projectRoot, ...extraArgs], {
    encoding: 'utf8',
    timeout: 5000,
    env: { ...process.env, MEMSPEC_ROOT: memspecRoot },
  });
  if (child.error || child.status !== 0) {
    if (process.env.MEMSPEC_HOOK_DEBUG) {
      process.stderr.write(`memspec-session-start: CLI failed (${child.error || 'exit ' + child.status}) args=${extraArgs.join(' ')}\n`);
      if (child.stderr) process.stderr.write(child.stderr);
    }
    return null;
  }
  return (child.stdout || '').trim();
}

function runHook(data) {
  try {
    const cwd = data.cwd || process.cwd();
    const memspecRoot = findMemspecRoot(cwd);
    if (!memspecRoot) {
      emit('');
      return;
    }

    // The store root looks like <project>/.memspec — pass <project> as --cwd.
    const projectRoot = path.dirname(memspecRoot);
    const personalStore = path.resolve(memspecRoot) === path.join(os.homedir(), '.memspec');
    const repo = personalStore ? repoTerm(cwd) : null;
    const scope = personalStore ? resolveScope(memspecRoot, cwd) : undefined;
    const scopeArgs = scope ? ['--scope', scope] : [];

    // Budget discipline (2026-09-01): the default boot list is the whole personal store
    // ranked by recency — 1,000+ claims, ~6.7 KB per session, mostly other projects. When
    // the personal store serves a git repo, ask for RELEVANCE instead: one query on the repo
    // name (the routing tag every record carries) plus one narrow query for the repo's
    // session-start pointer, which the handoff skill always titles "<repo> session-start".
    // A project-local store is already scoped to its repo, so it keeps the boot list under a
    // tighter budget. Numbers are tokens (memspec's own estimate).
    let context;
    if (repo) {
      const main = runContext(memspecRoot, projectRoot, ['--query', repo, '--budget', '600', '--limit', '8', ...scopeArgs]);
      const ptr = runContext(memspecRoot, projectRoot, ['--query', `${repo} session-start`, '--type', 'procedure', '--budget', '250', '--limit', '2', ...scopeArgs]);
      if (main === null && ptr === null) { emit(''); return; }
      const mainIds = new Set((main || '').match(/ms_[0-9A-Z]{26}/g) || []);
      const ptrLines = (ptr || '').split('\n').filter((l) => l.startsWith('- ') && /session-start/i.test(l))
        .filter((l) => { const m = l.match(/ms_[0-9A-Z]{26}/); return m && !mainIds.has(m[0]); });
      const parts = [];
      const mainBody = (main || '').replace(/^## Active project memory\s*/, '').trim();
      parts.push(`## Project memory (repo: ${repo}${scope ? ', scope: ' + scope : ''})` + (mainBody === '_No active memories._' || !mainBody
        ? ' — nothing indexed for this repo yet; memspec search before assuming.'
        : '\n\n' + mainBody));
      if (ptrLines.length) parts.push('### Session-start pointer\n' + ptrLines.join('\n'));
      context = parts.join('\n\n');
    } else {
      const out = runContext(memspecRoot, projectRoot, ['--budget', '700', ...scopeArgs]);
      if (out === null) { emit(''); return; }
      context = out;
    }
    // Dream passes always live in the personal store, even when a project
    // store won resolution — surface them regardless of cwd. A project/team
    // store can now run its own dream pass too (v0.12 precursor): check its
    // dream/ dir as well when it's a different directory than the home
    // store, so nothing is checked (or shown) twice for the common case
    // where the resolved store IS the home store.
    const homeMemspecRoot = path.join(os.homedir(), '.memspec');
    const dreamNoticeParts = [];
    const homeDreamNotice = pendingDreamNotice(homeMemspecRoot, 'store: ~/.memspec');
    if (homeDreamNotice) dreamNoticeParts.push(homeDreamNotice);
    if (path.resolve(memspecRoot) !== path.resolve(homeMemspecRoot)) {
      const projectDreamNotice = pendingDreamNotice(memspecRoot, `store: ${memspecRoot}`);
      if (projectDreamNotice) dreamNoticeParts.push(projectDreamNotice);
    }
    const dreamNotice = dreamNoticeParts.join('\n\n');
    const combined = [context, dreamNotice, claimsCheckNotice()].filter(Boolean).join('\n\n');
    if (!combined) {
      emit('');
      return;
    }

    emit(combined);
  } catch (e) {
    if (process.env.MEMSPEC_HOOK_DEBUG) {
      process.stderr.write(`memspec-session-start: error ${e && e.message}\n`);
    }
    emit('');
  }
}
