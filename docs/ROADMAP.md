# Roadmap

JARVIS stays **local-first**: `.harness/` per project, CLI on PATH, Cursor as adapter. Nothing here requires cloud.

## v0.3.x (current) — publishable

- [x] Cycle + SQLite + lock + recovery
- [x] Risk / Impact / Security / Memory / Test engines
- [x] PT natural language + Cursor rules/skills
- [x] `brief` / `memorize` / local `serve` (token savings)
- [x] MIT + CI + CONTRIBUTING + SECURITY
- [x] pause / resume / wait

## v0.4 — Git awareness (local + read-only remote)

- [ ] `jarvis reconcile --remote` — fetch + diff vs Cycle baseline
- [ ] Detect "remote advanced" / deleted branch / detached HEAD in tests
- [ ] Richer `git status` evidence in Cycle payload
- [ ] Stable `jarvis status --json` for scripts

**Still no:** push, merge, or automatic PR.

## v0.5 — GitHub as optional external gate

- [ ] `gh` CLI integration: PR status, checks, review state
- [ ] `jarvis wait` reads real checks when `GH_TOKEN` + remote exist
- [ ] Document flow: plan → dev → local commit → manual push → wait CI → close

## v0.6 — Engine depth

- [ ] L2 with Tree-sitter (TS/Python minimum)
- [ ] Impact with lightweight import graph
- [ ] Test matrix: concurrency, corrupt SQLite, recovery paths
- [ ] Orchestrator decision loop (explicit replan)

## v1.0 — maturity criteria

- [ ] 100% Phase 22 acceptance criteria verified in CI
- [ ] npm publish (`npm i -g jarvis`) or GitHub Releases with binary
- [ ] VS Code/Cursor extension (optional; rules/skills remain valid)
- [ ] Changelog + migration guide between minors

## Explicitly out of v1

- Shared Cycle state for teams
- Automatic push/merge/force
- Replacing the model or IDE
