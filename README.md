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

Durable Projects/Work Items/Workflow Runs, Mission token budgets (separate preparation and execution phases, dual-authorized grants, complexity-based estimates calibrated by history), AI runtime (router, scheduler, context builder, loop guards, Ollama and Claude Code adapters), Git/worktree handlers, Integration Resolver with an **advisory LLM interpretation** (it can add concerns for a human to read, never change the verdict), project knowledge store, change reports, channel intake (WhatsApp), MCP and CLI adapters, JSON Schema export.

Workflow safeguards: a **planning gate** (questions, complete plan, human-approved estimate before any execution), a **run guard** (changes only on a RUNNING run of the same Work Item), **plan step tracking** (a step is done only with matching successful operations; edits outside the plan need an amended plan), protected `.jarvis/` control files, a **learning journal** per Work Item, and **retention** of operational data (audit and ledgers are never touched).

Project contract: each project keeps its own contract, agreed scope and delivery history (`jarvis contract add CONTRACT contrato.pdf`). Only a human adds documents; a new version replaces the one consulted and the old one stays audited. A request can be triaged against them as repeated, in scope or out of scope, always citing the clause or past delivery, and anything without evidence goes back to the human.

## Verified against the real thing

- The container isolation profile runs against a **live Docker daemon in CI** (no network, read-only root, no host environment); the job fails if the check is skipped.
- The Ollama adapter is tested over a real HTTP connection, and both Ollama and Claude Code have opt-in live tests. See [`docs/TESTES-EXPLICADOS.md`](docs/TESTES-EXPLICADOS.md).
- A reproducible CLI tour: `bash scripts/demo.sh` (transcript in [`docs/DEMO.md`](docs/DEMO.md)).

## Next

Container profiles beyond the locked-down default, image provenance beyond digest pinning, delegation and revocation semantics, concurrency fairness beyond priority-then-FIFO, PR metadata conventions beyond explicit `wi_…` ids. See the open decisions in [`docs/architecture/GENERATION-2.md`](docs/architecture/GENERATION-2.md).

MIT
