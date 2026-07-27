import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MemspecStore } from '../lib/store.js';

/**
 * Stage 1 of transcript ingestion: normalize harness session logs into
 * trajectory-v1-shaped records (roles: meta / user / reasoning / assistant /
 * tool — after Letta's Trajectory format; own implementation, no dependency).
 *
 * Tool-agnostic core + per-harness adapters: only an adapter knows a
 * harness's native format; downstream consumers (distill / digest / dream)
 * see trajectory records only. Adding a harness = one adapter.
 *
 * Output stays LOCAL ONLY: <store>/local/trajectories/<source>/<session>.json.
 * `local/` must be gitignored in the store — raw and normalized transcripts
 * contain secrets and full file contents and never enter git sync.
 *
 * Deterministic, zero LLM tokens. Idempotent via a watermark in
 * <store>/local/state.json (mtime+size per source file); a still-growing
 * session is re-normalized in full when it changes.
 */

export interface NormalizeOptions {
  cwd?: string;
  source?: string;
  dryRun?: boolean;
  verbose?: boolean;
}

export interface TrajectoryRecord {
  role: 'meta' | 'user' | 'reasoning' | 'assistant' | 'tool';
  [key: string]: unknown;
}

interface SessionRef {
  file: string;
  sessionId: string;
}

interface HarnessAdapter {
  name: string;
  listSessions(): SessionRef[];
  normalize(file: string, sessionId: string): TrajectoryRecord[];
}

const MAX_TEXT = 10000;
const MAX_THINKING = 2000;
const MAX_TOOL_INPUT = 500;
const MAX_TOOL_OUTPUT = 1500;

function truncate(value: unknown, max: number): string {
  const s = typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
  return s.length > max ? `${s.slice(0, max)}\n[truncated ${s.length - max} chars]` : s;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === 'string' ? b : ((b as { text?: string }).text ?? '')))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function* jsonlLines(file: string): Generator<Record<string, unknown>> {
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line) as Record<string, unknown>;
    } catch {
      // tolerate torn writes at the tail of a live session
    }
  }
}

// Claude Code: ~/.claude/projects/<slug>/<session-id>.jsonl
// Quirk: tool results arrive as user-role lines with tool_result blocks —
// paired to the originating tool_use by id. Fable-class models redact
// thinking locally (empty string + signature), so reasoning records are
// best-effort.
const claudeCode: HarnessAdapter = {
  name: 'claude-code',
  listSessions() {
    const root = join(homedir(), '.claude', 'projects');
    if (!existsSync(root)) return [];
    const out: SessionRef[] = [];
    for (const dir of readdirSync(root)) {
      const full = join(root, dir);
      if (!statSync(full).isDirectory()) continue;
      for (const f of readdirSync(full)) {
        if (f.endsWith('.jsonl')) out.push({ file: join(full, f), sessionId: f.replace(/\.jsonl$/, '') });
      }
    }
    return out;
  },
  normalize(file, sessionId) {
    const records: TrajectoryRecord[] = [];
    const pendingTools = new Map<string, TrajectoryRecord>();
    const meta: TrajectoryRecord = { role: 'meta', source: 'claude-code', session_id: sessionId };
    let model: string | undefined;

    for (const o of jsonlLines(file)) {
      if (!meta.cwd && o.cwd) meta.cwd = o.cwd;
      if (!meta.git_branch && o.gitBranch) meta.git_branch = o.gitBranch;
      if (!meta.harness_version && o.version) meta.harness_version = o.version;
      if (typeof o.timestamp === 'string') {
        if (!meta.started_at) meta.started_at = o.timestamp;
        meta.ended_at = o.timestamp;
      }

      if (o.isMeta) continue;
      if (o.type !== 'user' && o.type !== 'assistant') continue;
      const msg = o.message as { model?: string; content?: unknown } | undefined;
      if (!msg?.content) continue;
      if (msg.model) model = msg.model;

      const blocks = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content as string }];
      for (const b of blocks as Array<Record<string, unknown>>) {
        if (b.type === 'text' && o.type === 'user') {
          const t = String(b.text ?? '').trim();
          if (!t || t.startsWith('<system-reminder')) continue;
          records.push({ role: 'user', text: truncate(t, MAX_TEXT) });
        } else if (b.type === 'text') {
          const t = String(b.text ?? '').trim();
          if (t) records.push({ role: 'assistant', text: truncate(t, MAX_TEXT) });
        } else if (b.type === 'thinking') {
          const t = String(b.thinking ?? '').trim();
          if (t) records.push({ role: 'reasoning', text: truncate(t, MAX_THINKING) });
        } else if (b.type === 'tool_use') {
          const rec: TrajectoryRecord = { role: 'tool', name: b.name, input: truncate(b.input, MAX_TOOL_INPUT) };
          records.push(rec);
          if (typeof b.id === 'string') pendingTools.set(b.id, rec);
        } else if (b.type === 'tool_result') {
          const rec = pendingTools.get(b.tool_use_id as string);
          const output = truncate(textOf(b.content), MAX_TOOL_OUTPUT);
          if (rec) {
            rec.output = output;
            if (b.is_error) rec.is_error = true;
            pendingTools.delete(b.tool_use_id as string);
          } else {
            records.push({ role: 'tool', name: 'unknown', output, ...(b.is_error ? { is_error: true } : {}) });
          }
        }
      }
    }
    if (model) meta.model = model;
    return [meta, ...records];
  },
};

// Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
// Lines: {timestamp, type, payload}. `developer`/`system` messages are
// injected boilerplate and event_msg lines duplicate response_item — both
// dropped. function_call(+output) paired by call_id.
const codex: HarnessAdapter = {
  name: 'codex',
  listSessions() {
    const root = join(homedir(), '.codex', 'sessions');
    if (!existsSync(root)) return [];
    const out: SessionRef[] = [];
    const walk = (dir: string): void => {
      for (const f of readdirSync(dir)) {
        const full = join(dir, f);
        if (statSync(full).isDirectory()) walk(full);
        else if (f.endsWith('.jsonl')) {
          const m = f.match(/rollout-.*-([0-9a-f-]{36})\.jsonl$/);
          out.push({ file: full, sessionId: m ? m[1] : f.replace(/\.jsonl$/, '') });
        }
      }
    };
    walk(root);
    return out;
  },
  normalize(file, sessionId) {
    const records: TrajectoryRecord[] = [];
    const pendingCalls = new Map<string, TrajectoryRecord>();
    const meta: TrajectoryRecord = { role: 'meta', source: 'codex', session_id: sessionId };

    for (const o of jsonlLines(file)) {
      if (typeof o.timestamp === 'string') {
        if (!meta.started_at) meta.started_at = o.timestamp;
        meta.ended_at = o.timestamp;
      }
      const p = (o.payload ?? {}) as Record<string, unknown>;
      if (o.type === 'session_meta') {
        if (p.cwd) meta.cwd = p.cwd;
        if (p.cli_version) meta.harness_version = p.cli_version;
        if (p.model_provider) meta.model_provider = p.model_provider;
        continue;
      }
      if (o.type === 'turn_context' && p.model && !meta.model) meta.model = p.model;
      if (o.type !== 'response_item') continue;

      if (p.type === 'message') {
        if (p.role === 'developer' || p.role === 'system') continue;
        const t = textOf(p.content).trim();
        if (!t) continue;
        records.push({ role: p.role === 'assistant' ? 'assistant' : 'user', text: truncate(t, MAX_TEXT) });
      } else if (p.type === 'reasoning') {
        const t = textOf(p.summary ?? p.content).trim();
        if (t) records.push({ role: 'reasoning', text: truncate(t, MAX_THINKING) });
      } else if (p.type === 'function_call' || p.type === 'local_shell_call' || p.type === 'custom_tool_call') {
        const rec: TrajectoryRecord = {
          role: 'tool',
          name: (p.name as string) ?? (p.type as string),
          input: truncate(p.arguments ?? p.input ?? p.action, MAX_TOOL_INPUT),
        };
        records.push(rec);
        if (typeof p.call_id === 'string') pendingCalls.set(p.call_id, rec);
      } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
        const rec = pendingCalls.get(p.call_id as string);
        const raw = p.output;
        const output = truncate(
          typeof raw === 'string' ? raw : (textOf((raw as { content?: unknown } | undefined)?.content) || JSON.stringify(raw)),
          MAX_TOOL_OUTPUT
        );
        if (rec) {
          rec.output = output;
          pendingCalls.delete(p.call_id as string);
        } else {
          records.push({ role: 'tool', name: 'unknown', output });
        }
      }
    }
    return [meta, ...records];
  },
};

export const ADAPTERS: Record<string, HarnessAdapter> = {
  'claude-code': claudeCode,
  codex,
};

interface WatermarkEntry {
  mtimeMs: number;
  size: number;
  records?: number;
  empty?: boolean;
}

interface NormalizeState {
  normalized: Record<string, WatermarkEntry>;
}

export function runNormalize(options: NormalizeOptions): string {
  if (options.source && !ADAPTERS[options.source]) {
    throw new Error(`unknown source '${options.source}' (have: ${Object.keys(ADAPTERS).join(', ')})`);
  }

  const store = new MemspecStore(options.cwd);
  const localDir = join(store.root, 'local');
  const outRoot = join(localDir, 'trajectories');
  const stateFile = join(localDir, 'state.json');

  let state: NormalizeState = { normalized: {} };
  try {
    state = { normalized: {}, ...JSON.parse(readFileSync(stateFile, 'utf8')) };
  } catch {
    // first run
  }

  const lines: string[] = [];
  let written = 0;
  let skipped = 0;
  let empty = 0;

  for (const adapter of Object.values(ADAPTERS)) {
    if (options.source && adapter.name !== options.source) continue;
    const outDir = join(outRoot, adapter.name);
    for (const { file, sessionId } of adapter.listSessions()) {
      const st = statSync(file);
      const key = `${adapter.name}:${sessionId}`;
      const mark = state.normalized[key];
      if (mark && mark.mtimeMs === st.mtimeMs && mark.size === st.size) {
        skipped++;
        continue;
      }

      const records = adapter.normalize(file, sessionId);
      // meta plus fewer than 2 real records: nothing to learn from
      if (records.length < 3) {
        state.normalized[key] = { mtimeMs: st.mtimeMs, size: st.size, empty: true };
        empty++;
        continue;
      }
      if (!options.dryRun) {
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, `${sessionId}.json`), JSON.stringify({ schema: 'trajectory-v1', records }, null, 1));
      }
      state.normalized[key] = { mtimeMs: st.mtimeMs, size: st.size, records: records.length };
      written++;
      if (options.verbose) lines.push(`${key}: ${records.length} records`);
    }
  }

  if (!options.dryRun) {
    mkdirSync(localDir, { recursive: true });
    writeFileSync(stateFile, JSON.stringify(state, null, 1));
  }
  lines.push(`normalized ${written}, unchanged ${skipped}, empty ${empty}${options.dryRun ? ' (dry-run)' : ''}`);
  return lines.join('\n');
}
