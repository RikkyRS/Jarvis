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
12. Token consumption is governed centrally and budgeted by Mission; every usage event remains attributable to its Project, Mission, Work Item, Workflow Run, agent, operation, provider, and model.

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
  └── Mission
        └── Work Item
              └── Workflow Run
                    └── Operations
                          └── Operation-specific Approval
```

- **Project**: repository/project boundary and shared project knowledge/policies. It may contain multiple Missions.
- **Mission**: durable, user-defined outcome or substantial body of work (for example, building a financial software product). It owns the approved token budget for its scope, retains its history after completion, and may be reopened for a separately evaluated and authorized improvement stage.
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
- A concise, interview-oriented learning note: the technical problem, the reason for the change, the main concept/decision involved, and what the user should be able to explain. Keep this note compact and grounded in verified implementation evidence; do not regenerate or narrate the entire project history.
- Files and symbols (functions/classes/components/contracts) changed.
- Approximate final-file line ranges as navigation aids, not stable identifiers.
- Commit SHA and/or diff reference where available.
- Problem addressed and acceptance criteria fulfilled.
- Tests/checks actually executed and their observed results.
- Known limitations, unresolved findings, and follow-up work.
- Evidence references from tools.

Line numbers alone are insufficient because they shift. Reports must be derived from actual diffs and tool results, not solely from an agent's narrative. Never claim a test passed unless its result is available. The Mission history is the durable source for later project explanation and interview preparation. Preserve concise, chronological records of changes and why they were made, together with the underlying decisions, evidence, tests, and outcomes. The user should be able to revisit the history and reconstruct the technical reasoning; do not rely on an on-demand LLM summary as the only record.

## AI Runtime and token governance

### Confirmed token policy

The authoritative token budget belongs to a **Mission**, not to a recurring calendar period and not to an individual agent. A Project may contain multiple Missions, each with its own independently authorized token allowance and complete usage history.

A Mission represents a substantial outcome agreed with the user. Before implementation, the Requirement & Context Analyzer gathers relevant context, clarifies material requirements, and works with the user to establish scope, architecture, deliverables, and acceptance criteria. Once the scope is agreed, the JARVIS estimates the required token allowance and requests the user's authorization for an initial grant.

A Mission's budget lifecycle is divided into two distinct authorization phases:

- **Preparation Budget**: a separate, bounded allowance for discovery and planning before the implementation scope is approved. It covers relevant project investigation, requirement clarification, architecture/design exploration, acceptance criteria, and the execution-budget estimate. Preparation usage is recorded against the Mission but is not silently transferred into or deducted from the later Execution Budget.
The Preparation Budget follows an **adaptive, stage-based estimation model**:

- Estimate preparation work by distinct stages (project investigation, requirement clarification, architecture/design analysis, risk assessment, and planning/documentation), rather than using one unexplained flat number.
- Use the known mission complexity, project size/knowledge, expected retrieval and analysis scope, and available historical usage from comparable work when valid.
- Set one initial bounded token estimate from the staged work. Present the stages and their estimated token amounts, without an uncertainty range or a long justification.
- Track actual usage and remaining preparation work continuously. If new findings materially change the estimate or the allowance is insufficient, pause before exceeding it, explain the reason and remaining stages, estimate the additional tokens, and request authorization.
- Re-estimate only affected stages when scope or evidence changes; do not restart the entire estimate without cause.

- **Execution Budget**: requested only after the user has reviewed and approved the prepared scope, deliverables, and acceptance criteria. The JARVIS presents one token estimate, broken down by execution stages/Work Items, and requests explicit authorization for the implementation work.
The Execution Budget follows the same **adaptive, stage-based estimation model**, with estimates organized around Work Items:

- Estimate each Work Item's expected implementation, tests, review, and integration activities.
- Aggregate Work Item estimates into one initial Mission Execution Budget, accounting for dependencies and shared activities without double-counting. Present the stages/Work Items and their estimated token amounts, without an uncertainty range or lengthy rationale.
- Track actual usage by agent, Work Item, Workflow Run, Operation, provider, and model. Re-estimate affected work when evidence or scope changes materially.
- If the remaining allowance is insufficient, pause before exceeding it, preserve checkpoints, report completed work and pending activities, estimate the additional tokens needed, and request an explicit additional grant.
- Additional grants are independently authorized and auditable within the same Mission execution history. Neither the runtime nor agents may increase the allowance themselves.


Preparation and execution allowances must be independently identifiable in the ledger and authorization records. The Preparation Budget itself requires an explicit authorization; its amount and any additional preparation grant are decided by the user, not invented or automatically increased by the runtime. If preparation allowance becomes insufficient, the JARVIS pauses AI-dependent preparation work, preserves its findings/checkpoints, reports what remains, estimates the additional preparation tokens needed, and waits for authorization. It must not begin implementation merely because preparation is complete or its budget is exhausted.

The Execution Budget is authorized against a versioned, agreed scope. Material scope changes or a new revision stage require reassessment; if more tokens are needed, the JARVIS requests a separately authorized additional execution grant. The two phases must never be conflated in progress reports or presented as one undifferentiated allowance.

The user may authorize a substantial initial allowance for the agreed scope. The JARVIS must not silently enlarge that allowance. If the mission is likely to exceed its remaining budget, it must pause new LLM calls as required by policy, preserve recoverable checkpoints, explain completed work and remaining work, estimate the additional tokens required, and request an explicitly authorized additional grant.

When the agreed scope is completed, the JARVIS presents an evidence-backed delivery for user evaluation. If the user requests changes or improvements, the JARVIS assesses the new work, estimates its token requirement, and requests a new authorized grant before proceeding when the existing allowance is insufficient. A completed Mission remains durable and reviewable; its history and usage ledger are never reset. Reopening it for another stage does not erase prior consumption or automatically replenish its budget.

### Token usage records

Capture, when the provider exposes them:

- input tokens;
- output tokens;
- cached input tokens (separately identified, not double-counted);
- estimated tokens before the call;
- actual usage reported after the call;
- provider/model identifiers and timestamp;
- associated Project, Mission, Work Item, Workflow Run, agent, and Operation IDs.

Estimated, actual, and unavailable measurements must be clearly distinguished. Never present an estimate as provider-reported actual usage.

### Token Budget Manager

A centralized Token Budget Manager mediates LLM calls and is responsible for:

- mission-level authorized allowance and consumption ledger;
- preflight estimates when practical;
- explicit, auditable initial and additional grants;
- atomic reservation/settlement to avoid concurrent overspending;
- configurable warning and restriction thresholds;
- hard enforcement of the mission's authorized budget;
- operational safeguards against loops, oversized outputs, and redundant calls;
- usage reporting by mission, agent, Work Item, Workflow Run, operation, provider, and model;
- checkpointing and resumable pause when the budget is exhausted or insufficient.

Agents cannot bypass this manager by calling a provider directly. Provider adapters must report usage consistently. Tools that do not invoke an LLM (for example, Git inspection, local file operations, and deterministic test execution) do not consume LLM tokens, though they remain subject to execution/time/resource policies.

### Mission budget lifecycle

1. **Preparation authorization**: request a bounded Preparation Budget before discovery/planning begins. Record the authorized amount and phase.
2. **Preparation and scope agreement**: investigate, clarify requirements, evaluate architecture/options, define deliverables and acceptance criteria, and estimate execution tokens. Keep preparation consumption separate from execution allowance.
3. **Execution authorization**: present the versioned scope and execution estimate; begin implementation only after explicit user approval of the Execution Budget.
4. **Execution and monitoring**: all agents and Work Items in the Mission share the authorized Execution Budget. Usage remains attributable to each agent, Work Item, Workflow Run, operation, provider, and model.
5. **Approaching/insufficient allowance**: notify the orchestrator at configurable thresholds, optimize work, preserve checkpoints, and report actual/estimated consumption and remaining work. Pause AI-dependent work when the phase's allowance is exhausted and wait for an explicit grant for that same phase.
6. **Delivery and evaluation**: when the agreed scope is complete, produce an evidence-backed report and submit the result for user evaluation.
7. **Revision stage**: if the user requests changes, clarify and estimate the revision. Request a separately authorized additional Execution Budget when needed; preserve the original Mission history and all previous usage records.

A grant must be auditable and immutable in the ledger: amount, phase (preparation/execution), grant type (initial/additional), authorizing actor, authorization timestamp, mission/scope version, reason, and relevant metadata. Preparation and execution grants are separate balances and cannot be transferred or silently combined. The runtime must never grant itself additional tokens. A user-approved increase changes only the authorized allowance for the specified phase through a distinct recorded event; it does not rewrite prior usage.

### Budget exhaustion and efficiency

- Configurable warning/restriction thresholds may notify the orchestrator, optimize context, reprioritize work, and prepare checkpoints. Initial numeric thresholds are proposals, not confirmed defaults.
- At the authorized hard limit, block new LLM calls and pause AI-dependent work with recoverable checkpoints. Deterministic operations may continue only if safe, useful, and permitted.
- If a provider call is already in flight when the limit is reached, record its actual reported usage when available and prevent further calls. Do not claim that an incomplete call completed.
- The orchestrator may reserve part of the already-authorized mission allowance for critical work; a reserve is not extra budget and cannot increase the authorized total.
- **Context Builder** constructs minimal task-relevant context.
- **Selective Retrieval** retrieves only relevant project knowledge and source evidence.
- **Deduplication** removes repeated context where safe.
- **Incremental Analysis** reanalyzes only impacted areas when dependency/invalidation evidence supports it.
- **Summarization** compacts history while preserving requirements, decisions, constraints, evidence, and unresolved questions.
- **Model Routing** chooses a suitable provider/model based on task complexity and policy.
- **Stop Conditions** detect unproductive loops and cap iterations/output.
- **Result Reuse** reuses prior analysis/test results only when their validity conditions still hold.

Context compression must not discard business rules, security constraints, approvals, or evidence needed for correctness.

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
- Domain hierarchy: Project → Mission → Work Item → Workflow Run → Operations, with operation-specific approvals. A Mission is a durable user-defined outcome and owns its authorized token budget.
- Parallel work isolation: hybrid Worktree model, reference branch per Work Item and isolated Worktree per Workflow Run.
- Work Items remain reopenable after a Worktree closes or an external reviewer requests changes; a new Workflow Run can continue the same Work Item.
- Use an independent Integration Resolver to assess the whole candidate branch, including multiple accumulated PRs/contributions, before promotion to `main`.
- The Integration Resolver must assess global context and independently verify evidence; implementation agents cannot be the final judges of their own combined contribution.
- The Resolver may diagnose and prepare proposed corrections in isolation, but cannot silently apply them, approve itself, or bypass human/runtime authorization.
- A failed global integration should be traced to affected contributions where possible, so only the relevant Work Item(s) need reopening.
- Clarify requirements before implementation, batch material questions, avoid repeating known valid information, and document acceptance criteria.
- Produce evidence-backed change reports explaining what changed and why, with files/symbols, approximate line ranges, commit/diff references, and actual test results.
- Token budget: shared within each Mission, with usage tracked by Project, Mission, agent, Work Item, Workflow Run, operation, provider, and model.
- Initial and additional token grants require explicit user authorization and immutable audit records; the runtime cannot increase its own allowance.
- Mission scope is clarified and agreed before the initial allowance is authorized; the JARVIS presents one token estimate broken down by preparation stages or execution Work Items, without an uncertainty range or lengthy estimate rationale.
- Preparation and execution use separate, independently authorized Mission token budgets. Preparation covers discovery/planning; execution is authorized only after the user approves the prepared scope and estimate. Preparation consumption is not deducted from the execution allowance, and the runtime cannot automatically increase either phase's budget.
- Preparation allowance sizing uses an adaptive, stage-based estimate: determine the initial bounded allowance from the estimated preparation stages and uncertainty, monitor actual consumption, and request explicit additional authorization if new findings or remaining work exceed the allowance.
- Execution allowance sizing uses an adaptive, Work-Item-based estimate covering implementation, tests, review, and integration. The Mission execution allowance aggregates these estimates with dependencies and uncertainty; insufficient allowance pauses execution and requires an explicit additional grant.
- At insufficient allowance, pause AI-dependent work with recoverable checkpoints, report progress and remaining work, estimate the additional requirement, and wait for user authorization.
- Completed Missions retain their history and usage ledger. User-requested revisions form a new work stage and require a new authorization when additional tokens are needed.

### Proposed, not yet finalized

- Initial warning threshold of 70%, restriction threshold of 90%, and hard stop at 100%.
- A protected token reserve for critical operations, carved out of the shared project budget.
- Specific model-routing and context-compaction algorithms.
- Exact technical acceptance criteria and schemas for Integration Resolver findings and contribution provenance.

### Open decisions

- Exact token warning/restriction threshold defaults and reserve policy.
- Detailed grant schema, authorization UX, and accounting behavior for provider usage unavailable or reported late.
- Detailed candidate branch/PR mechanics and merge strategy, to be decided against the actual repository workflow.
- Final domain contracts, persistence schema, state transitions, and threat model after implementation-level design review.
