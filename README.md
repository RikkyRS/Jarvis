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

See [`docs/USAGE.md`](docs/USAGE.md), [`docs/TESTING.md`](docs/TESTING.md) and [`docs/architecture/THREAT-MODEL.md`](docs/architecture/THREAT-MODEL.md).

## Develop

```bash
npm install
npm run ci   # typecheck, lint, tests, build
```

Requires Node >= 22.5 (`node:sqlite`).

## Also implemented

Durable Projects/Work Items/Workflow Runs, Mission token budgets (separate preparation and execution phases, dual-authorized grants), AI runtime (router, scheduler, context builder, loop guards, Ollama and Claude Code adapters), Git/worktree handlers, Integration Resolver, project knowledge store, change reports, channel intake (WhatsApp), MCP and CLI adapters, JSON Schema export.

## Next

Live-daemon container tests, LLM-assisted Resolver interpretation, automatic budget estimation, retention policy for operational data.

MIT
