#!/usr/bin/env node
// memspec claims-check — mechanically assert the machine-level enforcement
// claims an agent instruction file (CLAUDE.md) makes about supply-chain
// hygiene and memspec wiring. Prints PASS/WARN lines and ALWAYS exits 0: this
// runs at session start and must never fail or block the boot.
//
// Checks:
//   1. ~/.npmrc declares a release-age gate (min-release-age | minimum-release-age)
//   2. ~/.bunfig.toml declares minimumReleaseAge — OR bun is not installed
//   3. the memspec session-start hook is installed in the Claude Code config
//      directory: $CLAUDE_CONFIG_DIR when set, ~/.claude otherwise
//
// Usage: node hooks/memspec-claims-check.js
// HOME is honoured (via os.homedir()) and so is CLAUDE_CONFIG_DIR, so a caller
// can point either at a fixture.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

function readFileSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function bunInstalled() {
  try {
    const res = spawnSync('bun', ['--version'], { stdio: 'ignore', timeout: 1500 });
    // ENOENT → not on PATH. Any spawn that resolved the binary counts as present.
    return !(res.error && res.error.code === 'ENOENT');
  } catch {
    return false;
  }
}

function checkNpmrc(home) {
  const content = readFileSafe(path.join(home, '.npmrc'));
  if (content === null) {
    return ['WARN', 'npmrc: ~/.npmrc not found — no release-age gate for npm/pnpm'];
  }
  if (/^\s*(min-release-age|minimum-release-age)\s*=/m.test(content)) {
    return ['PASS', 'npmrc: release-age gate configured'];
  }
  return ['WARN', 'npmrc: no min-release-age/minimum-release-age key — fresh packages are not delayed'];
}

function checkBunfig(home) {
  if (!bunInstalled()) {
    return ['PASS', 'bunfig: bun not installed — release-age gate not required'];
  }
  const content = readFileSafe(path.join(home, '.bunfig.toml'));
  if (content !== null && /^\s*minimumReleaseAge\s*=/m.test(content)) {
    return ['PASS', 'bunfig: minimumReleaseAge configured'];
  }
  return ['WARN', 'bunfig: bun present but ~/.bunfig.toml has no minimumReleaseAge'];
}

// Mirrors claudeConfigDir() in src/lib/claude-config.ts; this file is copied
// into the config dir on its own, so it cannot import from the package.
function claudeConfigDir(home, env) {
  const raw = (env.CLAUDE_CONFIG_DIR || '').trim();
  if (!raw) return path.join(home, '.claude');
  if (raw === '~') return path.resolve(home);
  if (raw.startsWith('~/')) return path.resolve(home, raw.slice(2));
  return path.resolve(raw);
}

function checkSessionHook(home, env) {
  const claudeDir = claudeConfigDir(home, env);
  const shown = path.resolve(claudeDir) === path.resolve(home, '.claude') ? '~/.claude' : claudeDir;
  const hookFile = path.join(claudeDir, 'hooks', 'memspec-session-start.js');
  if (fs.existsSync(hookFile)) {
    return ['PASS', `session-hook: memspec-session-start.js installed under ${shown}/hooks`];
  }
  for (const settings of ['settings.json', 'settings.local.json']) {
    const content = readFileSafe(path.join(claudeDir, settings));
    if (content !== null && content.includes('memspec-session-start')) {
      return ['PASS', `session-hook: registered in ${shown}/${settings}`];
    }
  }
  return ['WARN', `session-hook: memspec session-start hook not found under ${shown}`];
}

function runClaimsCheck(home = os.homedir(), env = process.env) {
  return [checkNpmrc(home), checkBunfig(home), checkSessionHook(home, env)]
    .map(([level, msg]) => `${level} ${msg}`);
}

module.exports = { runClaimsCheck };

if (require.main === module) {
  const lines = runClaimsCheck();
  process.stdout.write(['memspec claims-check:', ...lines].join('\n') + '\n');
  process.exit(0);
}
