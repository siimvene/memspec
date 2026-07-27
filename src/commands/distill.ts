import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../lib/config.js';
import { claimsOf, matchesClaim, resolveLayerPath } from '../lib/registry.js';
import { MemspecStore } from '../lib/store.js';
import type { TrajectoryRecord } from './normalize.js';

/**
 * Stages 2 + 4 of transcript ingestion.
 *
 * distill: per-session LLM pass over local trajectories (produced by
 * `memspec normalize`) into short memory-formation digests at
 * <store>/local/digests/<source>/<session>.md. Incremental — runs as
 * sessions close, so a heavy week never becomes one giant batch (which
 * would not fit a context window anyway). LLM via MEMSPEC_DISTILL_BIN /
 * MEMSPEC_DISTILL_ARGS (default: `claude --model haiku -p` — cheap tier;
 * falls back to MEMSPEC_LLM_BIN if set).
 *
 * reduce: deterministic merge of per-session digests into a committed
 * experience digest at <store>/digests/<period>-<host>.md. Zero LLM
 * tokens — dream does the thinking over these. Hostname in the filename
 * keeps multi-machine stores conflict-free. Watermark-gated: no-op until
 * >= REDUCE_MIN_DAYS since the last reduce unless --force.
 *
 * Digests may leave the machine (reduce output is committed), so both
 * stages redact secret-shaped strings. Trajectories themselves stay local.
 */

export interface DistillOptions {
  cwd?: string;
  limit?: string;
  dryRun?: boolean;
  verbose?: boolean;
}

export interface ReduceOptions {
  cwd?: string;
  force?: boolean;
  dryRun?: boolean;
}

const DEFAULT_LIMIT = 25;
const MAX_PROMPT_CHARS = 400_000; // ~100k tokens; keeps giant sessions inside a cheap model's context
const MIN_REAL_RECORDS = 6; // below this a session has nothing to learn from
const LLM_TIMEOUT_MS = 180_000;
const MAX_FAILURES = 3;
const REDUCE_MIN_DAYS = 6;

const REDACT_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(sk|pk)-[A-Za-z0-9_-]{16,}\b/g,
  /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
  /\b(password|passwd|secret|token|api[_-]?key)\s*[=:]\s*['"]?[^\s'"]{8,}/gi,
  /\bBearer\s+[A-Za-z0-9._-]{20,}\b/g,
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const re of REDACT_PATTERNS) out = out.replace(re, '[REDACTED]');
  return out;
}

interface IngestState {
  normalized?: Record<string, unknown>;
  distilled?: Record<string, { at: string; failures?: number; skipped?: boolean }>;
  reduced?: { at: string; covered: string[] };
}

function localPaths(cwd?: string): { root: string; localDir: string; stateFile: string } {
  const store = new MemspecStore(cwd);
  const localDir = join(store.root, 'local');
  return { root: store.root, localDir, stateFile: join(localDir, 'state.json') };
}

function loadState(stateFile: string): IngestState {
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8')) as IngestState;
  } catch {
    return {};
  }
}

function saveState(stateFile: string, state: IngestState): void {
  mkdirSync(join(stateFile, '..'), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state, null, 1));
}

function listTrajectories(localDir: string): Array<{ source: string; sessionId: string; file: string }> {
  const trajRoot = join(localDir, 'trajectories');
  if (!existsSync(trajRoot)) return [];
  const out: Array<{ source: string; sessionId: string; file: string }> = [];
  for (const source of readdirSync(trajRoot)) {
    const dir = join(trajRoot, source);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.json')) out.push({ source, sessionId: f.replace(/\.json$/, ''), file: join(dir, f) });
    }
  }
  return out;
}

function trajectoryToPrompt(records: TrajectoryRecord[]): string {
  const meta = records[0];
  const lines: string[] = [
    'Distill this agent session transcript into a memory-formation digest.',
    '',
    `Session: ${meta.source} | cwd ${meta.cwd ?? 'unknown'} | branch ${meta.git_branch ?? '-'} | ${meta.started_at ?? '?'} -> ${meta.ended_at ?? '?'}`,
    '',
    'Transcript (normalized; tool outputs truncated):',
    '',
  ];
  const recordLines: string[] = [];
  for (const r of records.slice(1)) {
    if (r.role === 'tool') {
      recordLines.push(`[tool ${r.name}] ${String(r.input ?? '')}`);
      if (r.output) recordLines.push(`  -> ${String(r.output)}`);
    } else {
      recordLines.push(`[${r.role}] ${String(r.text ?? '')}`);
    }
  }
  // Budget the transcript: keep the head (framing) and tail (outcome) of a
  // giant session, elide the middle rather than overflow the model context.
  let total = 0;
  for (const l of recordLines) total += l.length + 1;
  if (total > MAX_PROMPT_CHARS) {
    const headBudget = MAX_PROMPT_CHARS * 0.6;
    const tailBudget = MAX_PROMPT_CHARS * 0.35;
    const head: string[] = [];
    let used = 0;
    let headEnd = 0;
    for (; headEnd < recordLines.length && used + recordLines[headEnd].length < headBudget; headEnd++) {
      head.push(recordLines[headEnd]);
      used += recordLines[headEnd].length + 1;
    }
    const tail: string[] = [];
    used = 0;
    let tailStart = recordLines.length;
    for (; tailStart > headEnd && used + recordLines[tailStart - 1].length < tailBudget; tailStart--) {
      tail.unshift(recordLines[tailStart - 1]);
      used += recordLines[tailStart - 1].length + 1;
    }
    recordLines.length = 0;
    recordLines.push(...head, `[... ${tailStart - headEnd} lines elided from the middle of a long session ...]`, ...tail);
  }
  lines.push(...recordLines);
  lines.push(
    '',
    '# Task',
    '',
    'Write the digest with ONLY these sections, omitting empty ones:',
    '',
    '## WHAT HAPPENED — 2-5 bullets, concrete outcomes (shipped X, fixed Y, decided Z).',
    '## DECISIONS — choices made and by whom, with one-line rationale.',
    '## PROBLEMS / FIXES — what broke, root cause, what fixed it.',
    '## DISCOVERED — non-obvious facts about systems/code worth remembering.',
    '## UNRESOLVED — open questions or work left hanging.',
    '',
    'Rules: under 250 words. Terse bullets, no prose padding. Name files, commands,',
    'ids, versions precisely. NEVER include credentials, tokens, keys, or passwords.',
    'Respond with the digest text directly — no preamble, no tools.'
  );
  return lines.join('\n');
}

function runLlm(prompt: string): { ok: boolean; output: string } {
  const bin = process.env.MEMSPEC_DISTILL_BIN || process.env.MEMSPEC_LLM_BIN || 'claude';
  const args = (process.env.MEMSPEC_DISTILL_ARGS ?? '--model haiku -p').split(' ').filter(Boolean);
  const child = spawnSync(bin, args, { input: prompt, encoding: 'utf8', timeout: LLM_TIMEOUT_MS });
  if (child.error || child.status !== 0) {
    const detail = child.stderr?.trim() || child.stdout?.trim() || (child.error ? String(child.error) : `exit ${child.status}`);
    return { ok: false, output: detail.slice(0, 500) };
  }
  return { ok: true, output: (child.stdout || '').trim() };
}

export function runDistill(options: DistillOptions): string {
  const { localDir, stateFile } = localPaths(options.cwd);
  const state = loadState(stateFile);
  state.distilled = state.distilled || {};

  const limit = options.limit ? parseInt(options.limit, 10) : DEFAULT_LIMIT;
  const lines: string[] = [];
  let done = 0;
  let skipped = 0;
  let failed = 0;
  let already = 0;

  for (const { source, sessionId, file } of listTrajectories(localDir)) {
    if (done + failed >= limit) break;
    const key = `${source}:${sessionId}`;
    const mark = state.distilled[key];
    const trajMtime = statSync(file).mtime.toISOString();
    if (mark && !mark.failures && mark.at >= trajMtime) {
      already++;
      continue;
    }
    if (mark && (mark.failures ?? 0) >= MAX_FAILURES) {
      already++;
      continue;
    }

    const records = (JSON.parse(readFileSync(file, 'utf8')) as { records: TrajectoryRecord[] }).records;
    if (records.length - 1 < MIN_REAL_RECORDS) {
      state.distilled[key] = { at: new Date().toISOString(), skipped: true };
      skipped++;
      continue;
    }

    if (options.dryRun) {
      lines.push(`${key}: would distill (${records.length - 1} records)`);
      done++;
      continue;
    }

    const result = runLlm(redactSecrets(trajectoryToPrompt(records)));
    if (!result.ok || !result.output) {
      state.distilled[key] = { at: new Date().toISOString(), failures: (mark?.failures ?? 0) + 1 };
      failed++;
      lines.push(`${key}: LLM failed (attempt ${(mark?.failures ?? 0) + 1}/${MAX_FAILURES}) — ${result.output.split('\n')[0]}`);
      continue;
    }

    const meta = records[0];
    const outDir = join(localDir, 'digests', source);
    mkdirSync(outDir, { recursive: true });
    const frontmatter = [
      '---',
      `session: ${sessionId}`,
      `source: ${source}`,
      `cwd: ${meta.cwd ?? 'unknown'}`,
      `started: ${meta.started_at ?? 'unknown'}`,
      `ended: ${meta.ended_at ?? 'unknown'}`,
      `records: ${records.length - 1}`,
      '---',
      '',
    ].join('\n');
    writeFileSync(join(outDir, `${sessionId}.md`), frontmatter + redactSecrets(result.output) + '\n');
    state.distilled[key] = { at: new Date().toISOString() };
    done++;
    if (options.verbose) lines.push(`${key}: distilled`);
  }

  if (!options.dryRun) saveState(stateFile, state);
  lines.push(`distilled ${done}, skipped ${skipped}, failed ${failed}, up-to-date ${already}${options.dryRun ? ' (dry-run)' : ''}`);
  return lines.join('\n');
}

export function runReduce(options: ReduceOptions): string {
  const { root, localDir, stateFile } = localPaths(options.cwd);
  const state = loadState(stateFile);

  if (!options.force && state.reduced) {
    const ageDays = (Date.now() - Date.parse(state.reduced.at)) / 86_400_000;
    if (ageDays < REDUCE_MIN_DAYS) {
      return `last reduce ${ageDays.toFixed(1)}d ago (< ${REDUCE_MIN_DAYS}d) — nothing to do (use --force to override)`;
    }
  }

  const covered = new Set(state.reduced?.covered ?? []);
  const digestRoot = join(localDir, 'digests');
  const fresh: Array<{ key: string; body: string; cwd: string; ended: string }> = [];
  if (existsSync(digestRoot)) {
    for (const source of readdirSync(digestRoot)) {
      const dir = join(digestRoot, source);
      if (!statSync(dir).isDirectory()) continue;
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.md')) continue;
        const key = `${source}:${f.replace(/\.md$/, '')}`;
        if (covered.has(key)) continue;
        const body = readFileSync(join(dir, f), 'utf8');
        const cwd = body.match(/^cwd: (.+)$/m)?.[1] ?? 'unknown';
        const ended = body.match(/^ended: (.+)$/m)?.[1] ?? '';
        fresh.push({ key, body, cwd, ended });
      }
    }
  }
  if (!fresh.length) return 'no new session digests since last reduce — nothing to do';

  fresh.sort((a, b) => a.ended.localeCompare(b.ended));
  const now = new Date();
  const period = now.toISOString().slice(0, 10);
  const host = hostname().split('.')[0];

  // Scope-claim routing: each digest goes to the store that claims its cwd
  // (highest-priority claim wins); a session nobody claims stays local rather
  // than crossing a sync boundary by default. When neither this store nor any
  // configured layer declares claims, legacy behaviour holds: everything
  // reduces into this store.
  const registry: Array<{ root: string; priority: number; claims: string[] }> = [];
  for (const layer of loadConfig(root).stores ?? []) {
    const layerRoot = new MemspecStore(resolveLayerPath(layer.path, join(root, '..'))).root;
    if (!registry.some((r) => r.root === layerRoot)) {
      registry.push({ root: layerRoot, priority: layer.priority, claims: claimsOf(layerRoot) });
    }
  }
  if (!registry.some((r) => r.root === root)) {
    registry.push({ root, priority: -1, claims: claimsOf(root) });
  }
  registry.sort((a, b) => b.priority - a.priority);
  const claimsConfigured = registry.some((r) => r.claims.length > 0);

  const byStore = new Map<string, typeof fresh>();
  const unclaimed: typeof fresh = [];
  for (const d of fresh) {
    const target = claimsConfigured
      ? registry.find((r) => r.claims.length > 0 && matchesClaim(r.claims, d.cwd))
      : { root };
    if (!target) {
      unclaimed.push(d);
      continue;
    }
    const list = byStore.get(target.root) ?? [];
    list.push(d);
    byStore.set(target.root, list);
  }

  const outputs: string[] = [];
  for (const [storeRoot, digests] of byStore) {
    const byCwd = new Map<string, typeof fresh>();
    for (const d of digests) {
      const list = byCwd.get(d.cwd) ?? [];
      list.push(d);
      byCwd.set(d.cwd, list);
    }
    const parts: string[] = [
      `# Experience digest — ${period} (${host})`,
      '',
      `_${digests.length} session(s) since last reduce. Produced by \`memspec reduce\` from local session digests; raw trajectories never leave the machine._`,
      '',
    ];
    for (const [cwd, list] of byCwd) {
      parts.push(`## ${cwd}`, '');
      for (const d of list) {
        const body = d.body.replace(/^---[\s\S]*?---\n*/, '');
        parts.push(`### session ${d.key}`, '', redactSecrets(body).trim(), '');
      }
    }
    const outDir = join(storeRoot, 'digests');
    const outFile = join(outDir, `${period}-${host}.md`);
    if (!options.dryRun) {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(outFile, parts.join('\n'));
    }
    outputs.push(`${digests.length} -> ${outFile}`);
  }

  if (!options.dryRun) {
    // Unclaimed digests stay out of `covered` so they route once claims exist.
    const routedKeys = [...byStore.values()].flat().map((d) => d.key);
    state.reduced = { at: now.toISOString(), covered: [...covered, ...routedKeys] };
    saveState(stateFile, state);
  }
  const unclaimedNote = unclaimed.length
    ? `; ${unclaimed.length} unclaimed session(s) held local (no store claims their cwd)`
    : '';
  return `reduced ${outputs.length ? outputs.join(', ') : 'nothing'}${unclaimedNote}${options.dryRun ? ' (dry-run)' : ''}`;
}
