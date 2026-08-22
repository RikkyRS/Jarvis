# Changelog

All notable changes to this project are documented here.  
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).  
Versioning follows [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] - 2026-08-22

### Added

- **Stable `jarvis status`** (`schemaVersion: jarvis.status.v1`) with session, lock, policy, git snapshot
- **`jarvis who` / `quem`** — who holds the Cycle lock
- **`jarvis export` / `import`** — redacted Cycle evidence packs for team review (import is read-only)
- Advisory `.harness/active-cycle.meta.json` on lock acquire
- Team playbook: `docs/TEAM.PLAYBOOK.md`
- Detached HEAD surfaced in status

## [0.4.0] - 2026-08-22

### Added

- **Project policy** via `.jarvis.json` / `.jarvis.yml` (risk thresholds, git remote, workflow gates)
- **`jarvis logs`** — event timeline from SQLite for debugging
- **`jarvis reconcile`** — local + optional remote fetch vs Cycle baseline (`REMOTE_ADVANCED`)
- **`jarvis wait --checks`** — reads GitHub PR checks via `gh` CLI when available
- **`jarvis doctor`** — reports schema version, `gh` probe, policy source
- Example policy: `docs/examples/jarvis.policy.example.json`

## [0.3.0] - 2026-08-22

### Added

- `jarvis brief` / `resumo` — compact JSON for agents (token savings)
- `jarvis memorize` / `memorizar` — HOST notes in PROJECT memory
- `jarvis serve` — local HTTP backend (`127.0.0.1:39217`), no GitHub dependency
- `.harness/cache/agent-brief.json` cache updated on every command
- GLOBAL memory filtered by project; auto-records STACK/TOP_LEVEL on `plan`
- Cursor rules/skills: **brief first**, explore repo only when needed

## [0.2.0] - 2026-08-22

### Added

- Evidence-first TypeScript runtime with Cycle, SQLite, lock, and recovery
- CLI commands + PT aliases (`planeje`, `desenvolva`, `teste`, `revise`, `feche`, etc.)
- `pause`, `resume`, `wait` for external gates (manual PR/CI)
- Structural L2 context (regex) auto on `plan` and with `--deep`
- L2-aware impact; accumulated risk; path-based impacted tests
- PROJECT memory dedup + GLOBAL recall/promotion (`~/.jarvis/global/`)
- Security scan + `npm audit` when `package.json` exists
- Cursor integration via rules/skills; auto-init on first `plan`
- SQLite migrations v2 (`dedup_key` on memory)
- 36 tests (unit, integration, recovery, fixtures)

### Documentation

- README (PT), INSTALLATION, INTEGRATION, architecture docs
- MIT license

### Known limits

- Host (Cursor/IDE) implements code within the envelope
- No automatic push, merge, or PR
- Structural L2, not Tree-sitter/AST
- State in local `.harness/` per project (gitignored)

### Infrastructure

- GitHub Actions CI (Node 20/22)
- CONTRIBUTING, SECURITY, issue/PR templates, Dependabot

[0.4.0]: https://github.com/RikkyRS/Jarvis/releases/tag/v0.4.0
[0.3.0]: https://github.com/RikkyRS/Jarvis/releases/tag/v0.3.0
[0.2.0]: https://github.com/RikkyRS/Jarvis/releases/tag/v0.2.0
