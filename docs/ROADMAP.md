# Roadmap

JARVIS stays **local-first**: `.harness/` per project, CLI on PATH, Cursor as adapter. Nothing here requires cloud for core use.

## v0.3.x — publishable local harness

- [x] Cycle + SQLite + lock + recovery
- [x] Risk / Impact / Security / Memory / Test engines
- [x] PT natural language + Cursor rules/skills
- [x] `brief` / `memorize` / local `serve` (token savings)
- [x] MIT + CI + CONTRIBUTING + SECURITY
- [x] pause / resume / wait

## v0.4.x (current) — senior solo + Git awareness

- [x] Project policy (`.jarvis.json` / `.jarvis.yml`)
- [x] `jarvis logs` — event timeline
- [x] `jarvis reconcile` / `--remote` — fetch + REMOTE_ADVANCED
- [x] `jarvis wait --checks` via `gh` CLI
- [x] Doctor reports schema, gh, policy source
- [ ] Stable `jarvis status --json` for scripts
- [ ] Detached HEAD / deleted upstream recovery tests

**Still no:** push, merge, or automatic PR.

## v0.5 — Team readiness (local + shared evidence)

See [TEAM.v05.md](./TEAM.v05.md).

- [ ] Cycle export / import packs (auditable, redacted)
- [ ] Team playbook (PR + CI + shared `.jarvis.json`)
- [ ] Multi-dev lock messaging / `who`
- [ ] Optional thin sync later (self-hosted) — not required for first cut

**Still no:** auto push/merge; Dropbox-shared SQLite.

## v0.6 — Engine depth

- [ ] L2 with Tree-sitter (TS/Python minimum)
- [ ] Impact with lightweight import graph
- [ ] Test matrix: concurrency, corrupt SQLite, recovery paths
- [ ] Orchestrator decision loop (explicit replan)

## v1.0 — maturity criteria

- [ ] Phase 22 acceptance criteria verified in CI
- [ ] npm publish or GitHub Releases binary
- [ ] VS Code/Cursor extension (optional; rules/skills remain valid)
- [ ] Changelog + migration guide between minors

## Explicitly out of v1

- Automatic push/merge/force
- Replacing the model or IDE
- Forcing cloud accounts to use the CLI
