# Team playbook (v0.5)

How two developers share JARVIS without a cloud brain.

## Shared policy (commit this)

Put `.jarvis.json` in the **application** repo (not only in the JARVIS runtime):

```json
{
  "version": 1,
  "risk": { "requireApprovalFrom": "HIGH", "blockCritical": true },
  "git": { "remote": "origin", "fetchOnReconcile": true },
  "workflow": { "requireTestBeforeClose": true }
}
```

## Daily flow

```text
Dev A                          Dev B / Reviewer
─────────────────────────────  ─────────────────────────────
jarvis planeje "…"
jarvis desenvolva [--approve]
# implement on branch
jarvis teste
jarvis exportar                jarvis importar --path pack.json
git push (manual)              review evidence pack
open PR (manual)
jarvis wait --checks           gh pr checks
jarvis feche
```

## Commands for coordination

| Command | Use |
|---------|-----|
| `jarvis status` | Stable JSON (`schemaVersion: jarvis.status.v1`) for scripts |
| `jarvis who` / `quem` | Who holds the Cycle lock |
| `jarvis export` / `exportar` | Evidence pack under `.harness/exports/` |
| `jarvis import` / `importar --path` | Read-only pack under `.harness/imports/` |
| `jarvis reconcile --remote` | Detect REMOTE_ADVANCED |
| `jarvis wait --checks` | Read PR checks via `gh` |

## Rules

1. **Import does not steal the active Cycle.** It stores evidence for review only.
2. **Lock is local.** Use the same `--session` on one machine; another session gets `CONFLICT`.
3. **`active-cycle.meta.json` is advisory** — optional to commit as a hint, not a distributed lock.
4. **No auto push/merge.** Humans own GitHub.

## Still later (v0.6+)

- Live team sync backend
- Tree-sitter L2 / import graph
- IDE extension enforcement
