# JARVIS — Generation 2 Architecture

Status: proposed foundation. Compatibility with the legacy 0.6.x runtime and local operational data is not required.

## Product definition

JARVIS is a provider- and host-agnostic engineering runtime for AI-assisted software development. It is the deterministic control plane between a human, AI clients, project knowledge, and tools that inspect or modify software projects. It is not a chatbot, IDE, or model.

AI clients may reason, plan, explain, and request capabilities. They cannot grant themselves permissions. Authorization and execution remain deterministic runtime responsibilities.

## Invariants

1. Evidence before assertion; unknown is a valid state.
2. LLM output, prompt text, tool arguments, and client-side flags are never proof of approval.
3. Least privilege for project scope, filesystem, environment, and tools.
4. High-impact operations require explicit operation-specific approval; critical operations are blocked by default.
5. All side effects pass through one policy-enforcing Execution Gateway.
6. Workflows, approvals, checkpoints, and evidence survive process restarts.
7. Claude, Cursor, VS Code, local agents, Python agents, and other clients use the same runtime contracts.
8. Recovery from stale or corrupt state is explicit; no silent destructive recovery.
9. Project state, knowledge, credentials, and approvals are isolated by project.
10. Every protected decision and side effect is auditable.
11. Implementation agents do not have final authority to validate the global integration of their own contributions.
12. Token consumption is governed centrally and measured at the project level.

## Logical architecture

```text
Human / AI clients / IDEs
       |                 |
      MCP               CLI
       \                 /
        Typed Application API
                  |
            Workflow Runtime
                  |
  +---------------+----------------+
  |               |                |
Project         Policy &         Approval
Intelligence     Risk             Gate
  |               |                |
Knowledge      Permission       Approval Store
Store          Engine               |
  +---------------+----------------+
                  |
           Execution Gateway
                  |
       Filesystem / Tests / Git
                  |
          Evidence & Audit Store

       AI Runtime (cross-cutting)
       - Provider Adapter
       - Model Router
       - Context Builder
       - Token Budget Manager
       - Usage Tracker
```

This is a logical separation. The first implementation may remain one local Node.js process backed by SQLite.

## Runtime boundaries

### Adapters and Application API

CLI and MCP are adapters. They translate intent into typed requests and call application use cases. They do not own policy, workflow state, or approval truth. An HTTP API may be added later, but must not create a weaker authorization path.

### Workflow Runtime

Owns state transitions, checkpoints, retries, idempotency, and recovery. Workflow state is durable data, not chat history. LLMs cannot bypass transitions.

### Project Intelligence

First analysis maps stack, architecture, modules, conventions, dependencies, tests, and security. It persists source-backed knowledge with timestamps and confidence. Later requests retrieve relevant knowledge selectively. Full refresh is explicit or justified by invalidation; ordinary file changes do not trigger a full LLM analysis. Before changing code, relevant claims are revalidated against current source.

### Intelligence Layer

LLM providers sit behind a provider interface. They may summarize evidence, propose plans, explain findings, and recommend tests. They may not approve operations, modify policy, bypass the gateway, or claim success without tool evidence. LangChain/LangGraph are optional here, not prerequisites for the deterministic core.

### Policy and Approval

Policy is deterministic and schema-validated. Project configuration may make policy stricter, never weaken mandatory safeguards. An approval is bound to one operation ID, project, workflow, actor, operation type, canonical target, normalized parameter/diff fingerprint, expiry, and single use. Changed targets, diffs, branches, remotes, commands, or relevant parameters invalidate it. Commit and push are separate approvals. Force push and destructive reset/clean remain blocked by default.

### Execution Gateway

The only route to side effects. It validates requests, canonicalizes project/target paths, evaluates policy, validates and consumes approval, constructs a minimal environment, runs in an isolation boundary, verifies results, and persists evidence. An advisory permission envelope is not a sandbox.

## Work domain and parallel execution

The domain hierarchy is:

```text
Project
  └── Work Item
        └── Workflow Run
              └── Operations
                    └── Operation-specific Approval
```

- **Project**: repository/project boundary and shared project knowledge/policies.
- **Work Item**: durable unit of requested work, with objective, requirements, acceptance criteria, decisions, and review feedback. It remains reopenable after an execution or worktree is closed.
- **Workflow Run**: one attempt to perform or revise a Work Item. A Work Item may have multiple runs over time.
- **Operation**: a concrete action, such as editing a file, running a test, staging paths, committing, or pushing.
- **Approval**: narrowly scoped authorization for a specific protected operation; it is not interchangeable with business/product acceptance.

### Worktree isolation — confirmed decision

Use a hybrid Git Worktree model:

- Each Work Item has a durable reference branch/line of work.
- Each Workflow Run receives an isolated Worktree and working branch.
- Separate runs and agents must not share a mutable working directory.
- A run's changes are reconciled into its Work Item reference branch through a controlled integration step.
- Closing/removing a Worktree does not close or delete its Work Item.
- A Work Item can be reopened later, including after external review requests changes. A new Workflow Run is created with a new Worktree and retrieves the prior requirements, evidence, decisions, and review feedback.
- Before removing a Worktree, preserve or explicitly disposition every uncommitted/unintegrated change. No silent loss.

Worktree isolation prevents direct working-directory interference; it does not prove semantic compatibility. Integration still requires independent validation.

## Batch integration and Integration Resolver

### Confirmed product decision

The user works in their local project and may prepare a candidate branch that accumulates multiple PRs or Work Item contributions. The candidate branch is intended to be promoted to `main` only after the complete set passes global validation.

The **Integration Resolver** is an independent specialist invoked when the user requests integration/promotion or when integration validation finds a problem. It is not embedded as the final judge inside the implementation agents.

Its responsibility is to evaluate the whole candidate branch in the context of the project, not merely accept the latest contribution because its implementation agent says it is correct.

### Responsibilities

1. Identify the exact base and candidate branch SHAs and the complete set of included contributions.
2. Build a contribution map linking commits, PRs where available, changed paths, Work Items, Workflow Runs, and originating operations.
3. Inspect diffs, dependency changes, shared files, public contracts, types, schemas, configuration, and business rules.
4. Detect textual conflicts, semantic conflicts, contract incompatibilities, dependency/order problems, and regressions.
5. Evaluate changes together, including whether a later contribution unintentionally changes the behavior expected by an earlier one.
6. Run deterministic checks and tests before spending LLM tokens on interpretation that tools can perform.
7. Use project knowledge selectively and verify relevant claims against current source.
8. Produce findings with severity, affected contribution(s), evidence, and recommended next action.
9. When useful, prepare a proposed resolution in an isolated integration Worktree; never silently rewrite an originating contribution.
10. Re-run relevant and global checks after corrections and produce a final integration report.

### Independence and authority boundaries

- Implementation agents may report their own tests and reasoning, but those reports are evidence to verify, not final approval.
- The Integration Resolver has a global evaluation mandate and must independently inspect code, Git state, test output, and project contracts.
- It must not assume every agent is wrong; it must assess the combined result objectively.
- It may recommend accept, request changes, or block promotion. It cannot grant human approval or bypass runtime policy.
- Any prepared correction must retain provenance and be attributable to a Work Item/Workflow Run. Applying it is a protected side effect governed by the Execution Gateway and relevant approval.
- Technical acceptance by the Resolver is distinct from human/business acceptance (for example, a manager's review) and from permission to execute a Git operation.
- A failed global validation should identify the responsible contribution where evidence allows. The affected Work Item can be reopened in a new Workflow Run without restarting unrelated Work Items.

### Candidate branch promotion flow

```text
Independent Work Items / Workflow Runs / Worktrees
                  |
       controlled contribution integration
                  |
       candidate integration/release branch
          (may contain multiple PRs)
                  |
        user requests global integration
                  |
          independent Integration Resolver
                  |
       findings / proposed corrections / tests
                  |
        reopen only affected Work Item(s)
                  |
       rerun global validation on exact candidate SHA
                  |
       technical recommendation + evidence report
                  |
      human acceptance + operation-specific approval
                  |
             promotion to main
```

The candidate branch must be validated as a whole. Passing individual PR checks does not imply that the combined branch is valid. Conversely, a conflict is a diagnostic signal requiring analysis, not automatically proof that an implementation agent failed.

Promotion must be bound to the exact candidate SHA that was reviewed. If the branch changes after validation, the prior validation result and approval are stale and must be reevaluated. Commit, push, and merge/promotion are distinct protected operations with distinct approvals according to policy.

## Requirement clarification and execution quality

### Requirement & Context Analyzer

Before implementation, the JARVIS should understand the request and gather relevant project context. It should:

1. Interpret the requested outcome and retrieve existing project knowledge.
2. Inspect only the relevant source, tests, contracts, and documentation.
3. Identify functional/non-functional requirements, dependencies, risks, and ambiguities.
4. Ask concise questions for material unknowns instead of silently inventing requirements.
5. Group related questions into as few clarification rounds as practical.
6. Avoid asking for information already known and still valid.
7. Convert confirmed answers into explicit requirements and acceptance criteria.
8. Present alternatives, tradeoffs, and a recommendation when a meaningful architectural, security, data, cost, or product decision is required.

Low-impact, reversible implementation details may follow established project conventions. Material decisions remain with the user.

### Execution and verification

- Prefer deterministic tools for deterministic work; use LLM calls only where interpretation or synthesis adds value.
- Avoid redundant agents, repeated repository scans, duplicate context, and unnecessary retries.
- Test the smallest relevant scope first, then expand based on risk and integration requirements.
- Reuse previous results only when their inputs, code state, environment, and validity conditions still match.
- Preserve recoverable checkpoints and explain pauses/failures.

### Change report — required deliverable

Every completed implementation/revision should produce an evidence-backed report containing:

- Work Item and Workflow Run identifiers.
- Summary of what changed and why.
- Files and symbols (functions/classes/components/contracts) changed.
- Approximate final-file line ranges as navigation aids, not stable identifiers.
- Commit SHA and/or diff reference where available.
- Problem addressed and acceptance criteria fulfilled.
- Tests/checks actually executed and their observed results.
- Known limitations, unresolved findings, and follow-up work.
- Evidence references from tools.

Line numbers alone are insufficient because they shift. Reports must be derived from actual diffs and tool results, not solely from an agent's narrative. Never claim a test passed unless its result is available.

## AI Runtime and token governance

### Confirmed token policy

The JARVIS uses a **shared token budget per Project**, not independent primary budgets for each agent. The user selected token-count control only; mandatory financial cost accounting is out of scope for this policy.

Shared budget does not mean untracked usage. Every usage event should be attributable to its project, Work Item, Workflow Run, agent, operation, provider, and model.

### Token usage records

Capture, when the provider exposes them:

- input tokens;
- output tokens;
- cached input tokens (separately identified, not double-counted);
- estimated tokens before the call;
- actual usage reported after the call;
- provider/model identifiers and timestamp;
- associated Project, Work Item, Workflow Run, agent, and Operation IDs.

Estimated, actual, and unavailable measurements must be clearly distinguished. Never present an estimate as provider-reported actual usage.

### Token Budget Manager

A centralized Token Budget Manager mediates LLM calls and is responsible for:

- project-level available budget and consumption ledger;
- preflight estimates where practical;
- atomic reservation/settlement to avoid concurrent overspending;
- configurable warning and restriction thresholds;
- hard enforcement of the project budget;
- operational safeguards against loops, oversized outputs, and redundant calls;
- usage reporting by agent/task/run/provider/model;
- checkpointing and resumable pause when the budget is exhausted.

Agents cannot bypass this manager by calling a provider directly. Provider adapters must report usage consistently. Tools that do not invoke an LLM (for example, Git inspection, local file operations, and deterministic test execution) do not consume LLM tokens, though they remain subject to execution/time/resource policies.

### Efficiency mechanisms

- **Context Builder**: constructs a minimal, task-relevant context.
- **Selective Retrieval**: retrieves only relevant project knowledge and source evidence.
- **Deduplication**: removes repeated context where safe.
- **Incremental Analysis**: reanalyzes only impacted areas when dependency/invalidation evidence supports it.
- **Summarization**: compacts history while preserving requirements, decisions, constraints, evidence, and unresolved questions.
- **Model Routing**: chooses a suitable provider/model based on task complexity and policy, not simply the most capable model.
- **Stop Conditions**: detects unproductive loops and caps iterations/output.
- **Result Reuse**: reuses prior analysis/test results only when their validity conditions still hold.

Context compression must not discard business rules, security constraints, approvals, or evidence needed for correctness.

### Shared budget exhaustion policy — confirmed hybrid decision

The user selected a hybrid policy:

- At a configurable warning threshold (initial proposal: 70%), notify the orchestrator and optimize context/redundant work.
- At a configurable restriction threshold (initial proposal: 90%), suspend nonessential AI calls, reprioritize work, and preserve checkpoints.
- At 100%, block new LLM calls, checkpoint and pause workflows that require AI, and await user-authorized budget replenishment or a new budget period.
- Deterministic operations may continue only if safe, useful, and permitted; no workflow may falsely report completion because its AI budget is exhausted.
- The orchestrator may prioritize work and protect a reserved portion of the same project budget for critical activities. A reserve is part of the total budget, not extra tokens.
- If a provider call is already in flight when the limit is reached, record its actual reported usage when available and prevent further calls. Do not claim that an incomplete call completed.

The 70% and 90% thresholds and the size/eligibility of any reserve are initial design proposals, not yet finalized configuration defaults.

The capped carryover rule is confirmed, but its numeric cap and the detailed accounting/expiry behavior for additional grants remain open decisions.

### Budget renewal — confirmed hybrid decision

The user selected a hybrid renewal model:

- Each Project has a configurable recurring base token allowance for a defined period.
- The project may receive additional token grants when needed, without changing the recurring base allowance.
- Base allowance and additional grants contribute to the same shared project budget and are consumed under the same Token Budget Manager.
- Every grant must be auditable: amount, source/reason, authorizing actor, creation time, and applicable validity/expiry metadata.
- The runtime must not silently increase the allowance. Additional grants require an explicit authorized action.
- Each Project configures its own recurring allowance period; projects do not have to share one global period length.
- Each Project configures its own renewal time zone using an IANA time-zone identifier (for example, `America/Sao_Paulo`). Period boundaries are interpreted in that Project's configured local time zone, while persisted instants and ledger timestamps use UTC. The renewal clock time is configurable per Project and defaults to `00:00` local time when omitted. Daylight-saving-time transition handling remains an explicit open decision and must prevent duplicate renewals or ambiguous period boundaries.
- Unused tokens follow a **capped carryover** policy: a configurable maximum amount may roll into the next allowance period; any unused balance above that cap expires at the period boundary. The cap is not yet assigned a numeric default.
- The exact rollover/expiry and consumption-order rules for additional token grants remain open and must be defined explicitly; grants must not be treated as perpetual by assumption.
- Period renewal must not erase usage history or interrupt the audit ledger. It creates a new allowance period while preserving prior records and outstanding execution checkpoints.

This is a token-count policy; it does not require financial cost tracking.

## Data architecture

A clean schema baseline is allowed; legacy SQLite data is not a compatibility requirement. Separate operational state (workflows, checkpoints, locks, approvals, executions, events), project knowledge (versioned Markdown or structured documents with provenance), configuration, and secrets. SQLite is suitable for the initial local runtime. Knowledge files must be written atomically. Secrets must not enter knowledge documents, approval hashes, or ordinary logs.

A future shared deployment requires explicit identity, authentication, authorization, tenant isolation, and secret management. The local server must not simply be exposed to a network.

## Security baseline

Threats include prompt injection in repository content, malicious MCP clients, confused-deputy behavior, forged/replayed approvals, command injection, path traversal and symlink escapes, malicious package scripts, secret exfiltration, concurrency races, and interrupted side effects. Start local-only, restrict project roots, minimize inherited environment, bound input/output, allowlist tools, and use OS-level process isolation where available.

## Git policy

Read-only inspection may be automatic. Stage only reviewed paths. Commit and push each require distinct approval. Push verifies remote, branch, and expected HEAD. Force push is blocked by default. No automatic merge or PR creation in the first generation. Verify and record resulting SHAs after side effects.

For candidate promotion, validate the exact candidate SHA and require a separate operation-specific approval for the promotion/merge. A validation result is invalidated if the candidate changes.

## Implementation sequence

1. Architecture, threat model, domain language, invariants.
2. Clean domain contracts and workflow state machine.
3. Persistence schema and transactional repositories.
4. Policy engine and operation-specific approval lifecycle.
5. Execution Gateway and process isolation.
6. Project Intelligence and durable knowledge lifecycle.
7. Workflow runtime and recovery.
8. MCP and CLI adapters.
9. Git, test execution, candidate-branch integration, and Integration Resolver.
10. AI Runtime, token accounting/budget enforcement, and context efficiency.
11. Adversarial tests, CI, documentation, and release.

Each stage needs acceptance criteria and tests before dependent work begins. The implementation sequence may be refined after domain and threat-model reviews; do not introduce a framework solely to satisfy an architectural label.

## Compatibility policy

Legacy 0.6.x code, database, and local `.harness/` state are reference material only. Contracts, module boundaries, schema, CLI, and MCP may change incompatibly. Obsolete capabilities may be removed and old local operational data may be discarded. Any destructive local reset must be explicit and documented. Public Git history and `main` remain preserved during development.

## Decision log and status

This document is the persistent architecture source of truth for the Generation 2 work. Update it as decisions are made. Keep confirmed decisions separate from proposals and open questions. Conversation history is not the sole source of architectural truth.

### Confirmed by the user

- Preserve the public repository history and keep `main` intact during the redesign.
- Work in the isolated evolution branch `feat/approval-gate-foundation`.
- A clean redesign is allowed; legacy local operational data and compatibility are not mandatory.
- Domain hierarchy: Project → Work Item → Workflow Run → Operations, with operation-specific approvals.
- Parallel work isolation: hybrid Worktree model, reference branch per Work Item and isolated Worktree per Workflow Run.
- Work Items remain reopenable after a Worktree closes or an external reviewer requests changes; a new Workflow Run can continue the same Work Item.
- Use an independent Integration Resolver to assess the whole candidate branch, including multiple accumulated PRs/contributions, before promotion to `main`.
- The Integration Resolver must assess global context and independently verify evidence; implementation agents cannot be the final judges of their own combined contribution.
- The Resolver may diagnose and prepare proposed corrections in isolation, but cannot silently apply them, approve itself, or bypass human/runtime authorization.
- A failed global integration should be traced to affected contributions where possible, so only the relevant Work Item(s) need reopening.
- Clarify requirements before implementation, batch material questions, avoid repeating known valid information, and document acceptance criteria.
- Produce evidence-backed change reports explaining what changed and why, with files/symbols, approximate line ranges, commit/diff references, and actual test results.
- Token budget: shared per project, with usage tracked by agent/task/run/operation/provider/model; token counts only, no mandatory financial budget.
- Token exhaustion: hybrid policy — optimize and reprioritize as the budget is consumed, then pause AI-dependent work at the hard limit with recoverable checkpoints.
- Token budget renewal: hybrid recurring base allowance per Project plus explicitly authorized additional token grants; each Project configures its own recurring period length, IANA time zone, and local renewal clock (default `00:00`), with instants persisted in UTC.
- Unused token balances use capped carryover: up to a configurable cap rolls into the next period; the excess expires. The numeric cap remains open.

### Proposed, not yet finalized

- Initial warning threshold of 70%, restriction threshold of 90%, and hard stop at 100%.
- A protected token reserve for critical operations, carved out of the shared project budget.
- Specific model-routing and context-compaction algorithms.
- Exact technical acceptance criteria and schemas for Integration Resolver findings and contribution provenance.

### Open decisions

- Daylight-saving-time transition handling for per-Project renewal boundaries; the IANA time-zone identifier and configurable local reset clock (default `00:00`) are confirmed.
- Numeric value and configuration scope of the capped carryover limit.
- Exact rollover/expiry behavior and consumption ordering for additional token grants.
- Exact token threshold defaults and reserve policy.
- Detailed candidate branch/PR mechanics and merge strategy, to be decided against the actual repository workflow.
- Final domain contracts, persistence schema, state transitions, and threat model after implementation-level design review.
