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
  'Before answering questions, planning work, or editing code:',
  '1. Search Memspec for relevant facts, decisions, and procedures.',
  '2. Prefer active memory over stale assumptions.',
  '',
  'While working:',
  '1. Write durable project truths back to Memspec as:',
  '   - `fact` for current state or constraints',
  '   - `decision` for choices and rationale',
  '   - `procedure` for repeatable workflows',
  '2. If the store is thin and you are scanning the repo anyway, persist stable facts, decisions, and procedures you discover.',
  '3. If you discover memory drift, correct the stale memory instead of leaving both versions active.',
  '',
  'Do not treat Memspec as a chat transcript dump or private scratchpad. It is for durable repo knowledge that should survive agent resets.',
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
