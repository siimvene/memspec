# Memspec — Vision

## Problem

Every codebase accumulates tribal knowledge — architecture decisions, configuration rationale, principles, component relationships, the "why" behind things that `git blame` only shows the "what" of. In human teams, this lives in people's heads and gets transferred through onboarding, pairing, and conversation. It's fragile, lossy, and doesn't scale.

AI agents make this worse. They start every session with an empty context. They can read the code but not the reasoning behind it. They don't know that the auth system was rewritten last month, that the old REST endpoints are being deprecated, or that the team deliberately chose consistency over performance in the data layer. Each session rediscovers context that previous sessions already had.

Current approaches:
- **File-based systems** (CLAUDE.md, Cursor rules, markdown logs): human-readable and git-friendly, but static. They capture a snapshot of knowledge, not a living system that evolves with the code.
- **Memory services** (Mem0, Zep, Hindsight, etc.): strong capture and search, but opaque databases disconnected from the codebase. The knowledge lives outside the repo it describes.

Neither camp solves the core problem: **project knowledge that stays current as the codebase evolves, so that any agent — or human — starting cold can pick up where the last session left off.**

## Goal

Define an open methodology for managing living project knowledge — the tribal memory of a codebase — so it evolves with the code and is always available to any agent or human starting fresh.

Memspec specifies:
1. What types of knowledge to capture (facts, decisions, procedures)
2. How knowledge moves through a lifecycle (capture, promotion, decay, correction)
3. How stale knowledge gets corrected when the codebase changes (self-correction)
4. How an agent starting cold retrieves current project state (context-appropriate retrieval)
5. How multiple agents and humans share this knowledge through files in the repository

The active memory store is always the current truth about the project. Git history has the evolution. An agent loading memory at session start gets the equivalent of a team onboarding — not a replay of history, but what's true right now.

The reference implementation is markdown-canonical, git-backed, and has zero required dependencies. An optional search index can be derived from the files but is never the source of truth.

## Audience

### Primary: OpenClaw community
Agent workflows in Claude Code, Codex CLI, and similar tools. Developers who want a better convention than ad-hoc MEMORY.md files.

### Secondary: Thesis research
Semi-autonomous agents doing incident triage, analysis, and self-repair. These agents run on Claude CLI applications and need durable memory — pattern recognition across incidents, runbook knowledge, what worked before. Same methodology, different retrieval profile.

## Design Constraints

- **Methodology first**: the spec is the contribution, the implementation is a reference
- **3 memory types**: facts, decisions, procedures — complexity beyond this is human-bound, not agent-bound
- **No human curation**: fully autonomous. Self-correction through agent/human correction signals, not review queues
- **Markdown-canonical**: files are the source of truth, indexes are derived
- **Git-backed**: full history and auditability
- **One-directional sync**: files → index, never index → files
- **Local-first**: must work without hosted services
- **Agent-agnostic**: any agent that can read/write files participates
- **MCP as optional integration surface**: not required

## Prior Art

### MoltBrain
Studied as reference. Good plumbing (SQLite + ChromaDB, MCP surface, web viewer, session hooks). Wrong foundation for a methodology — observation-centric, flat types, no lifecycle, no governance. Decision: study ideas, don't fork.

### memsearch (Zilliz)
Closest philosophical match — markdown-canonical with vector index as derived artifact. But no typed memories, no lifecycle, no self-correction. Good substrate, no operating system.

### OpenClaw Workspace Memory
Siim's current system. Strong memory operating system (governance, types, lifecycle, correction capture, procedure evolution) on a weak substrate (markdown + grep, LLM-dependent automation). Memspec formalizes and generalizes this.

### Beads (Steve Yegge)
Shares the git-backed, file-canonical philosophy. Different problem space — task/issue tracking, not agent memory. Complementary, not competitive.
