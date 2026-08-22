# Phases

| Phase | Name | Status |
|-------|------|--------|
| 0 | Bootstrap | done |
| 1 | Contracts / schemas | done |
| 2 | SQLite persistence / event log | done (+ v2 migrations `dedup_key`) |
| 3 | Cycle engine + lock | done (+ pause/resume/wait) |
| 4 | Reconciliation / recovery | done |
| 5 | Orchestrator | done |
| 6 | Tool registry / permission | done |
| 7 | Execution engine | done |
| 8 | Git engine | done |
| 9 | Contract / acceptance | done |
| 10 | Context L0/L1/L2 | L0/L1 done; structural L2 (auto on `plan`, `--deep` on `context`) |
| 11 | Impact engine | done (+ L2 signals) |
| 12 | Risk engine | done (+ accumulated over Cycle) |
| 13 | Memory engine | done (+ PROJECT dedup, GLOBAL recall/promotion, `brief`) |
| 14 | Capabilities | done |
| 15 | Test engine | done (+ path-based impacted tests) |
| 16 | Security engine | done (+ `npm audit` when `package.json` exists) |
| 17 | `.harness` + SQLite | done |
| 18 | CLI | done (+ PT aliases, `brief`, `memorize`, `serve`) |
| 19 | Adapters | TS/Python/Ruby language ports + IDE names |
| 20 | Test architecture | unit + integration + recovery + fixtures |
| 21 | E2E Cycle | done |
| 22 | Final review | see `review.md` |

Honest limits: JARVIS is not the model. It does not implement application features alone. L2 does not use Tree-sitter in this version (structural regex fallback). No automatic push/merge/PR. MIT license.
