# Memspec — Research Notes

## MoltBrain Analysis

Source: https://github.com/nhevers/MoltBrain

### What It Is
- Memory layer for AI coding agents
- TypeScript/Bun runtime, worker service on :37777
- SQLite + ChromaDB for storage and vector search
- Web UI for timeline/viewer
- MCP surface for agent integration
- REST API
- OpenClaw integration path exists

### What It Gets Right
- **Retrieval UX**: semantic search + timeline browsing beats grepping markdown
- **Runtime integration**: session hooks (onSessionStart, onMessage, onResponse, onSessionEnd) for auto-capture
- **Queryable state**: DB + vector index + API is a real substrate
- **Product completeness**: viewer, analytics, tags, filters, export, API

### What It Gets Wrong (for our purposes)
- **Observation-centric, not governance-centric**: stores things, doesn't manage their lifecycle
- **Flat memory types**: preference, decision, learning, context — much simpler than what we need
- **No promotion pipeline**: no pathway from raw observation to curated durable memory
- **Rename/churn debt**: OpenClaw integration docs still reference claude-recall, MoltBot, clawd
- **Single contributor**: maintenance risk for building on top of
- **No governance**: no PII/secret filtering, no approval gates, no audit trail
- **Coupled to specific runtimes**: not truly agent-agnostic

### Ideas Worth Stealing
- Session lifecycle hooks for capture
- SQLite + vector search as index layer
- Timeline-based viewer
- MCP method surface design
- Tag/filter system

### Decision
Study as reference, don't fork. Build purpose-fit substrate with our memory semantics from day one.

---

## Current OpenClaw Workspace Memory Analysis

Source: /home/siim/.openclaw/workspace/

### Architecture Layers
1. **Session bootstrap**: Agent loads identity, user context, daily notes, long-term memory at start
2. **Daily notes**: `memory/YYYY-MM-DD.md` — raw event log
3. **Curated long-term**: `MEMORY.md` — quick facts, decisions, context, permanent facts, lessons, breadcrumbs
4. **Procedures**: `memory/procedures/` — evolving workflows
5. **Structured sidecars**: `memory/corrections.jsonl`, `memory/lessons.md`, `memory/sessions.jsonl`
6. **Automation pipeline**:
   - Observer (`observer.py`): compresses daily notes into `observations.md` with typed metadata and importance scoring
   - Reflector (`reflector.py`): archives observations when too large, leaves semantic hooks
   - Dream cycle (`dream-cycle.py`): nightly indexing, cross-ref, dedup, gap-check, report
7. **Heartbeat maintenance**: deliberate windows for memory review and state updates

### Strengths
- Explicit memory taxonomy with intended lifetimes and promotion paths
- Behavioral discipline: verification, correction capture, decay tiers
- Human-readable, git-friendly, zero external dependencies
- Resilience through redundancy: manual + observer + reflector + dream cycle + heartbeat

### Weaknesses
- Automation scripts depend on LLM paths that are often unavailable (OpenRouter disabled, local model partial)
- Retrieval is grepping markdown — no semantic search
- Promotion is policy-enforced, not tool-enforced
- Cross-memory querying is primitive
- Security is policy-based, not substrate-based

### Key Insight
This is a strong **memory operating system** (governance, types, lifecycle) on a weak **substrate** (markdown + cron). Memspec should preserve the operating model and replace the substrate.

---

## Comparison Matrix

| Capability | OpenClaw Workspace | MoltBrain | Memspec (Target) |
|------------|-------------------|-----------|-----------------|
| Memory types | Rich (5+ typed categories) | Flat (4 types) | Rich (9+ types with lifecycle) |
| Promotion pipeline | Policy-defined, manually enforced | None | Tool-enforced, auto + human |
| Decay/TTL | Policy-defined | Not visible | First-class with configurable profiles |
| Retrieval | Grep/read files | Semantic + timeline | Semantic + metadata + budget-aware |
| Capture | Manual + fragile automation | Session hooks, automatic | Session hooks + file watch + API |
| Governance | Policy-heavy, not enforced | Minimal | PII filter, provenance, audit trail |
| Storage | Markdown files | SQLite + ChromaDB | Markdown-canonical + derived index |
| UI | None (file editor) | Web viewer + timeline | Review queue + timeline + search |
| Agent integration | File-based, prompt-driven | MCP + hooks | MCP + REST + CLI + file watch |
| Git-backed | Yes | No | Yes |
| Offline/degraded | Full (it's just files) | No (needs service) | Degraded read (files), full with service |

---

## Effort Estimates

| Phase | Scope | Effort |
|-------|-------|--------|
| 1. Foundation | Markdown schema, store layout, git integration, CLI skeleton | 1-2 weeks |
| 2. Service + Index | File watcher, search index (SQLite + vector), MCP + REST API | 2-3 weeks |
| 3. Classification | LLM pipeline with rule fallback, dedup, confidence scoring | 1-2 weeks |
| 4. Promotion + Decay | Promotion queue, auto-promote rules, decay/TTL, archival | 1-2 weeks |
| 5. Retrieval | Context-aware retrieval, profiles, token budgeting, ranking | 1-2 weeks |
| 6. Governance | PII/secret filtering, provenance, policy enforcement | 1 week |
| 7. UI | Review queue, timeline, search, promotion workflow | 1-2 weeks |
| 8. Evaluation | Retrieval precision, promotion quality, token cost metrics | 1 week |

**Usable MVP (phases 1-3)**: 4-7 weeks
**Solid platform (phases 1-6)**: 8-14 weeks
**Full product (all phases)**: 10-16 weeks
