# Memspec

A methodology and CLI for managing living project knowledge in agent workflows.

Memspec keeps markdown files under `.memspec/` as the canonical source of truth. The CLI is a thin local tool for creating, validating, and later searching that memory without turning the format into a database-owned system.

## Package Shape

- `docs/` holds the spec, research, reality check, and AGENTS addon.
- `src/` holds the TypeScript CLI.
- `.memspec/` inside a project is the memory store itself.

## Current CLI Slice

The first implemented commands are:

- `memspec init`
- `memspec add`
- `memspec validate`

Later commands like `search`, `status`, `decay`, and `correct` should build on the same file-canonical model rather than replace it.

## Quickstart

```bash
npm install
npm run build
node dist/cli.js init
node dist/cli.js add fact "JWT auth" --body "JWT with refresh tokens" --source therin --tags auth,api
node dist/cli.js validate
```

## Docs

- `docs/SPEC.md`
- `docs/DESIGN.md`
- `docs/RESEARCH.md`
- `docs/REALITY-CHECK.md`
- `docs/AGENTS-ADDON.md`
- `docs/plans/2026-04-04-cli-foundation.md`

## License

MIT
