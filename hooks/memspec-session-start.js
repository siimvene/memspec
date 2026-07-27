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
// marker consistent across machines). Dream is a personal-store feature, so
// the check targets the home store regardless of which store won resolution.
function pendingDreamNotice(memspecRoot) {
  try {
    const dreamDir = path.join(memspecRoot, 'dream');
    if (!fs.existsSync(dreamDir)) return '';
    const pending = fs
      .readdirSync(dreamDir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort()
      .map((f) => ({ name: f, body: fs.readFileSync(path.join(dreamDir, f), 'utf8') }))
      .filter((d) => !/^_?Reviewed:/im.test(d.body));
    if (!pending.length) return '';

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

    let notice = `## Dream pass pending review\n\n${latest.name.replace('.md', '')} (${counts.join(', ')}) at dream/${latest.name} — proposals only, nothing auto-applied. Offer to walk the operator through it; after review, prepend a "_Reviewed: <date> — <disposition summary>_" line under the title and commit.`;
    if (questions.length) notice += `\nOpen questions needing the operator: ${questions.join(' | ')}`;
    if (pending.length > 1) notice += `\n(${pending.length - 1} older unreviewed pass(es) also pending.)`;
    return notice;
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

    const child = spawnSync('memspec', ['context', '--format', 'markdown', '--cwd', projectRoot], {
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, MEMSPEC_ROOT: memspecRoot },
    });

    if (child.error || child.status !== 0) {
      if (process.env.MEMSPEC_HOOK_DEBUG) {
        process.stderr.write(`memspec-session-start: CLI failed (${child.error || 'exit ' + child.status})\n`);
        if (child.stderr) process.stderr.write(child.stderr);
      }
      emit('');
      return;
    }

    const context = (child.stdout || '').trim();
    // Dream passes live only in the personal store, even when a project
    // store won resolution — surface them regardless of cwd.
    const dreamNotice = pendingDreamNotice(path.join(os.homedir(), '.memspec'));
    const combined = [context, dreamNotice].filter(Boolean).join('\n\n');
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
