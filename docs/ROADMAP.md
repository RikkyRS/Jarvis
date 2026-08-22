# Roadmap

JARVIS stays **local-first**: `.harness/` per project, CLI on PATH, Cursor as adapter. Nothing here requires cloud for core use.

## v0.3.x — publishable local harness

- [x] Cycle + SQLite + lock + recovery
- [x] Risk / Impact / Security / Memory / Test engines
- [x] PT natural language + Cursor rules/skills
- [x] `brief` / `memorize` / local `serve` (token savings)
- [x] MIT + CI + CONTRIBUTING + SECURITY
- [x] pause / resume / wait

## v0.5.x (current) — team readiness (local + shared evidence)

- [x] Stable `jarvis status` (`schemaVersion: jarvis.status.v1`)
- [x] `jarvis who` — lock holder / session
- [x] `jarvis export` / `import` — redacted Cycle evidence packs
- [x] Advisory `active-cycle.meta.json`
- [x] Team playbook (`docs/TEAM.PLAYBOOK.md`)
- [x] Detached HEAD surfaced in status

See [TEAM.v05.md](./TEAM.v05.md) and [TEAM.PLAYBOOK.md](./TEAM.PLAYBOOK.md).

**Still no:** auto push/merge; live multi-machine SQLite sync.

## v0.4.x — senior solo + Git awareness

- [x] Project policy (`.jarvis.json` / `.jarvis.yml`)
- [x] `jarvis logs` — event timeline
- [x] `jarvis reconcile` / `--remote`
- [x] `jarvis wait --checks` via `gh`
- [x] Doctor reports schema, gh, policy source

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
