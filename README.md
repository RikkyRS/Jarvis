# JARVIS — Generation 2

Deterministic, provider-agnostic engineering runtime for AI-assisted development.
AI clients may reason and request; **authorization and execution stay deterministic**.

Source of truth for the design: [`docs/architecture/GENERATION-2.md`](docs/architecture/GENERATION-2.md).
The Generation 1 harness (0.6.x) is preserved at git tag `legacy-0.6.0-gen1` and is not compatible.

## Implemented so far (1.0.0-alpha)

| Area                   | Where                      | What it guarantees                                                                                     |
| ---------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------ |
| Contracts              | `src/domain/contracts.ts`  | Zod is the canonical source; unknown fields rejected                                                   |
| Workflow state machine | `src/domain/workflow.ts`   | Only valid transitions; Work Items are reopenable                                                      |
| Policy                 | `src/policy`               | LOW/MEDIUM allow, HIGH needs approval, CRITICAL blocked; config can only tighten                       |
| Approvals              | `src/approval`             | Operation-bound, fingerprinted, expiring, single-use; only a human principal decides                   |
| Audit                  | `src/persistence/audit.ts` | Append-only (DB triggers) + hash chain for tamper detection                                            |
| Execution Gateway      | `src/gateway`              | Single route to side effects: canonical paths, policy, approval consumption, isolation check, evidence |

Untrusted project code never runs on the host: without a container runner the Gateway blocks it.

## Develop

```bash
npm install
npm run ci   # typecheck, lint, tests, build
```

Requires Node >= 22.5 (`node:sqlite`).

## Next (see implementation sequence in the architecture doc)

Persistence of Projects / Work Items / Workflow Runs, Mission and token budgets, MCP + CLI adapters,
Git handlers, worktrees, Integration Resolver.

MIT
