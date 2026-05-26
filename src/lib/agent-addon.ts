import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ADDON_MARKER_START = '<!-- memspec:init:start -->';
const ADDON_MARKER_END = '<!-- memspec:init:end -->';

export const AGENT_ADDON_BLOCK = [
  ADDON_MARKER_START,
  '## Memory (Memspec)',
  '',
  'This project uses Memspec for structured memory. `.memspec/` is the canonical store for durable project knowledge.',
  'Memspec is agent-operated, not human-curated with agent access.',
  '',
  '### On session start',
  'In Claude Code (and any harness supporting `SessionStart` hooks), the relevant active memories are auto-injected at session start. You should already see them in this prompt.',
  'As a fallback: Run `memspec search` for context relevant to the task. Prefer active memories over stale assumptions.',
  '',
  '### Before answering operational questions',
  'When your next action requires project-specific operational knowledge — how to deploy, where services run, server addresses, credential paths, established workflows — search memspec first.',
  'Run `memspec search <topic>` (e.g. `memspec search deploy`, `memspec search server`) before falling back to generic pattern-matching (Dockerfile, CI configs, Makefile).',
  'The memory store is the documented answer; the repo scan is the guess. Never skip this step even if you believe you can infer the answer from repo structure.',
  '',
  '### When to write memories',
  'After these events, write or correct memories immediately — don\'t defer to session end:',
  '- **Fixed a bug** → write/correct the relevant `fact` about how the system works',
  '- **Changed architecture or configuration** → correct stale `decision`/`fact`, write new ones',
  '- **Established a workflow** (deploy, test, debug sequence) → write a `procedure`',
  '- **Discovered something non-obvious** about the codebase → write a `fact`',
  '- **Made a design choice** between alternatives → write a `decision` with rationale',
  '',
  'Use `memspec add <type> "<title>" --body "<content>" --source <agent> --tags <tags>`.',
  'Use `memspec correct <id> --reason "<why>" --replace "<new content>"` for stale memories.',
  '',
  '### Guidelines',
  '- Only write knowledge that helps a future agent starting cold. No session transcripts.',
  '- If the store is thin, persist stable facts and decisions you discover while scanning the repo.',
  '- If you discover memory drift, correct the stale memory — don\'t leave both versions active.',
  '- Never store secrets in memory files.',
  '- When classifying, ask: does a future agent need this to understand *why* (decision), to *do something* (procedure), or to know *what\'s true* (fact)?',
  ADDON_MARKER_END,
].join('\n');

const AGENT_FILE_CANDIDATES = ['AGENTS.md', 'CLAUDE.md'] as const;

export interface AgentInstructionPatchResult {
  path: string;
  changed: boolean;
  created: boolean;
}

export function patchAgentInstructions(projectRoot: string): AgentInstructionPatchResult {
  const existingCandidate = AGENT_FILE_CANDIDATES
    .map((name) => join(projectRoot, name))
    .find((path) => existsSync(path));

  const targetPath = existingCandidate ?? join(projectRoot, 'AGENTS.md');
  const created = !existsSync(targetPath);
  const current = created ? '' : readFileSync(targetPath, 'utf8');

  if (current.includes(ADDON_MARKER_START) && current.includes(ADDON_MARKER_END)) {
    return {
      path: targetPath,
      changed: false,
      created,
    };
  }

  const next = current.trimEnd().length > 0
    ? `${current.trimEnd()}\n\n${AGENT_ADDON_BLOCK}\n`
    : `${AGENT_ADDON_BLOCK}\n`;

  writeFileSync(targetPath, next, 'utf8');

  return {
    path: targetPath,
    changed: true,
    created,
  };
}
