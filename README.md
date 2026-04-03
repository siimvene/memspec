# Memspec

A methodology for managing living project knowledge — the tribal memory of a codebase. Architecture decisions, configuration rationale, principles, component relationships: captured, kept current as the code evolves, and available to any agent or human starting cold.

Reference implementation: markdown files in a git repo. Zero dependencies. Any agent that can read/write files participates.

## Core Ideas

- **Living knowledge, not static docs**: memories self-correct as the codebase evolves. Active memory always reflects current state.
- **3 memory types**: facts, decisions, procedures. That's it.
- **Autonomous lifecycle**: capture → classify → active → decay → archive. No human gates.
- **Self-correction**: agents signal when a memory is stale or wrong. The system updates.
- **Cold start onboarding**: an agent loading memory at session start gets what's true now, not a replay of history.
- **Markdown-canonical**: files are the source of truth. Indexes are optional and derived.
- **Git-backed**: every state transition is a commit. Full audit trail. Evolution is traceable.

## Status

Design phase. See [VISION.md](VISION.md) for motivation and [DESIGN.md](DESIGN.md) for architecture.

## License

Open source (license TBD).
