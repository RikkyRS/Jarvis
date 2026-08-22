# v0.5 — Team readiness (plan)

Goal: make JARVIS usable by a **small team** without turning it into a cloud agent or auto-push bot.

## Problem

Today Cycles live in `.harness/` (gitignored, single machine).  
Two developers cannot share evidence, lock, or memory safely.

## Principles (non-negotiable)

1. **Local-first still wins** — each machine can run offline; team sync is optional.
2. **GitHub is remote + CI**, not the JARVIS brain.
3. **No automatic push / merge / force**.
4. **Evidence-first** — shared state must remain auditable.

## Proposed architecture

```
Dev A .harness/ ──┐
                  ├──► Team store (self-hosted OR shared export)
Dev B .harness/ ──┘
         ▲
         │ optional sync
         ▼
   Git remote (PR + CI checks via gh)
```

### Option A — Shared export (simpler)

- `jarvis export-cycle` → JSONL evidence pack (no secrets)
- Commit pack to `docs/cycles/` or artifact store
- `jarvis import-cycle` on another machine
- Lock remains local; coordination is social + PR

### Option B — Team backend (stronger)

- Self-hosted SQLite/Postgres on LAN or private VPS
- Sync: cycle status, evidence hashes, approvals, memory PROJECT (scoped)
- Distributed lock with TTL + session identity
- Auth: token per developer (no OAuth required for v0.5)

**Recommendation for v0.5:** start with **Option A**, design APIs so Option B can land in v0.6.

## Work packages

### WP1 — Shared policy (done foundations in v0.4)

- [x] `.jarvis.json` risk / git / workflow
- [ ] Team defaults: protected paths, requireTestBeforeClose=true in example team policy
- [ ] Document how to commit `.jarvis.json` in app repos

### WP2 — Remote awareness (partially done)

- [x] `reconcile --remote`
- [x] `wait --checks` via `gh`
- [ ] Stable `status --json` for scripts
- [ ] Detect detached HEAD / deleted upstream in recovery tests

### WP3 — Cycle export / import

- [ ] Export Cycle evidence + contract + risk history (redact secrets)
- [ ] Import as read-only review Cycle or attach to active Cycle
- [ ] CLI: `jarvis export`, `jarvis import`

### WP4 — Multi-session / multi-dev safety

- [ ] Clear CONFLICT messages when lock held
- [ ] `jarvis who` — show session + lock holder
- [ ] Optional advisory file `.harness/active-cycle.meta.json` (safe to share hints, not DB)

### WP5 — Docs + demo

- [ ] Team playbook: plan → branch → PR → wait --checks → close
- [ ] Fixture demo with two temp projects simulating two developers

## Explicitly out of v0.5

- Shared live SQLite over NFS/Dropbox
- Automatic PR creation
- Role-based admin UI
- Replacing Cursor rules with enforced IDE extension (v1.0)

## Success criteria

1. Two developers can follow the same Cycle evidence via export/import or PR comments.
2. CI checks gate `wait` without JARVIS pushing anything.
3. `.jarvis.json` is the single shared policy file in the app repo.
4. All new behavior covered by tests; `npm run ci` green.

## Suggested first implementation order

1. `status --json` + recovery tests for git edge cases  
2. `export` / `import` Cycle packs  
3. Team playbook in docs  
4. Optional thin team sync later (Option B)
