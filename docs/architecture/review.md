# Final review (Phase 22)

Status: **v0.3.0 — sign-off for local use + open source publication**

Properties verified in code and tests:

- Evidence-first: UNKNOWN/INFERRED/KNOWN in records; memory never overrides git/filesystem
- HIGH requires `--approve`; CRITICAL stays blocked
- Retry limit of 3 and loop detection by fingerprint
- Cycle lock per session
- Human changes enter HUMAN layer → `protectedHumanPaths`
- Orchestrator owns flow; CLI only dispatches
- TypeScript, Python, and Ruby adapters live outside the core
- SQLite + event log + v2 migrations; separate current state
- PROJECT memory dedup + GLOBAL recall/promotion
- `brief` / `memorize` / local `serve` for token-efficient agent workflow
- pause / resume / WAITING_EXTERNAL for manual gates
- GitHub Actions CI (Node 22/24): typecheck, lint, build, test, doctor
- **MIT** license
- No automatic push/merge/PR (invariant preserved)

Intentionally open (see [ROADMAP.md](../ROADMAP.md)):

- Feature implementation by the model (host / Cursor)
- AST/Tree-sitter parser (L2 is structural regex today)
- Native IDE extension (Cursor rules/skills cover the adapter)
- GitHub API / `gh` checks integration (roadmap v0.5)
- Shared multi-dev state (out of v1 scope)

Confirmed operating model:

- **Local-first:** `.harness/` gitignored per project
- **Git:** snapshot, local reconcile, optional commit on `close`; push is manual
- **Publication:** repo + CI + docs; runtime usage stays via local CLI
