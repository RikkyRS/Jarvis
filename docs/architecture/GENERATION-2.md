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

This is a logical separation. The first implementation may remain one local Node.js process backed by SQLite, behind persistence interfaces that avoid coupling domain logic to a database vendor.

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

The user selects the candidate branch for each integration operation; the JARVIS must not assume a permanent integration branch. The Integration Resolver selects a suitable contribution strategy (for example, merge or cherry-pick) based on repository state and contribution relationships, records provenance, and never silently changes source contributions. PR creation remains a separately controlled capability and is not automatic in the first generation. Conflicts may be investigated and a proposed correction prepared in an isolated Worktree; if no safe correction can be established, block integration and return affected Work Items for revision. Promotion must be bound to the exact candidate SHA that was reviewed. If the branch changes after validation, the prior validation result and approval are stale and must be reevaluated. Commit, push, and merge/promotion are distinct protected operations with distinct approvals according to policy.

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

A grant must be auditable and immutable in the ledger: amount, phase (preparation/execution), grant type (initial/additional), authorizing actor, authorization timestamp, mission/scope version, concise reason, and relevant metadata. The authorizing actor must be the Mission owner or a project administrator explicitly authorized by project access-control policy. Preparation and execution grants are separate balances and cannot be transferred or silently combined. The runtime must never grant itself additional tokens. A user-approved increase changes only the authorized allowance for the specified phase through a distinct recorded event; it does not rewrite prior usage. The authorization prompt presents the requested amount, current phase allowance, consumption, remaining balance, and concise reason before awaiting explicit confirmation.

### Budget exhaustion and efficiency

- The default warning threshold is 75% of the authorized phase allowance; the restriction threshold is 90%; the hard stop is 100%. Configuration may make thresholds more conservative but cannot weaken the hard stop or mandatory safeguards.
- At the restriction threshold, reduce avoidable context, redundant calls, nonessential work, and expensive model routing where policy permits.
- A critical-work reserve may be configured as a portion of the already-authorized phase allowance. It is not additional budget, must be visible in allowance accounting, and cannot be created or enlarged by the runtime without explicit authorization.
- At the authorized hard limit, block new LLM calls and pause AI-dependent work with recoverable checkpoints. Deterministic operations may continue only if safe, useful, and permitted.
- If a provider call is already in flight when the limit is reached, allow that call to settle, record actual reported usage when available, and prevent subsequent calls. Do not claim that an incomplete call completed.
- When provider usage is unavailable, preserve the state as unavailable or estimated; never represent an estimate as provider-reported actual usage. If a late actual report arrives, append a reconciliation record linked to the original call, retain the earlier state for audit, and update derived totals without erasing history.
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

A clean schema baseline is allowed; legacy SQLite data is not a compatibility requirement. Use SQLite for the first local implementation, with repository/persistence interfaces that keep domain and application layers portable to PostgreSQL if a future deployment requires it. Separate operational state (workflows, checkpoints, locks, approvals, executions, events), project knowledge (versioned Markdown or structured documents with provenance), configuration, and secrets. Knowledge files must be written atomically. Secrets must not enter knowledge documents, approval hashes, or ordinary logs.

Important domain events (state transitions, grants, approvals, protected operations, execution outcomes, reconciliation events, and audit-relevant decisions) are append-only and immutable. Maintain transactional current-state projections and checkpoints/snapshots for efficient reads and recovery; do not require every low-level internal action to become a domain event or impose full event sourcing on the entire system.

A future shared deployment requires explicit identity, authentication, authorization, tenant isolation, and secret management. The local server must not simply be exposed to a network.

## Security baseline

Threats include prompt injection in repository content, malicious MCP clients, confused-deputy behavior, forged/replayed approvals, command injection, path traversal and symlink escapes, malicious package scripts, secret exfiltration, concurrency races, and interrupted side effects. Start local-only, restrict project roots, minimize inherited environment, bound input/output, allowlist tools, and use OS-level process isolation where available. Default to least privilege and deny-by-default execution. Project configuration may tighten mandatory controls but may not disable them. Mission grants may be authorized by the Mission owner or a project administrator only when that administrator has explicit grant-authorization permission; enforce this through deterministic access control, not an AI agent.

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

### Confirmed by the user

- Token warning threshold: 75%; restriction threshold: 90%; hard stop: 100%.
- A configurable critical-work reserve may be carved out of the already-authorized phase allowance; it never increases the authorized total.
- Initial and additional grants may be authorized by the Mission owner or a project administrator explicitly granted that permission by project access-control policy.
- Additional-grant authorization presents the requested amount, current phase allowance, consumption, remaining balance, and concise reason, then waits for explicit confirmation.
- Grant records are immutable and auditable. Provider usage unavailable at call completion remains explicitly unavailable/estimated; late actual usage creates a linked reconciliation record while preserving history.
- In-flight provider calls are allowed to settle when the hard limit is reached; no subsequent calls start until a valid allowance is available.
- The user selects the candidate branch for each integration operation. The Integration Resolver selects the appropriate contribution integration strategy based on evidence and repository state, recording provenance.
- Conflicts may result in an isolated proposed correction. If no safe correction is available, block integration and return affected Work Items for revision.
- Integration Resolver recommends; the human accepts; the Execution Gateway requires operation-specific authorization for promotion.
- Any candidate branch change invalidates the prior global validation and approval; reevaluate the exact new SHA.
- SQLite is the initial local database, with persistence abstractions designed to preserve a future PostgreSQL path.
- Audit-significant domain events are immutable and append-only, with transactional current-state projections and checkpoints. Full event sourcing of every internal action is not required.
- Security defaults to local-first, least privilege, deny-by-default execution, isolated processes, minimal environment, and mandatory safeguards that project configuration cannot weaken.
- Change reports contain execution stages, a compact summary of the technical changes and why, and a concise interview-oriented learning note. The durable chronological Mission history preserves decisions, evidence, tests, and outcomes; no uncertainty range or lengthy estimate justification is required.

### Confirmed technical design decisions — 2026-11-23

The user selected option C for all seven technical design questions. These choices are confirmed product/architecture decisions and supersede any conflicting preliminary proposal in this document.

#### 1. Project Admin grant authorization — dual authorization

A Project Admin may authorize an additional Mission token grant only when both conditions hold:

- The administrator has an explicit, deterministic project-level permission to authorize Mission grants.
- The Mission Owner has explicitly authorized that administrator to exercise this grant authority for the relevant Mission.

The two checks are cumulative, not alternatives. Neither an administrator's general project role nor an AI agent's interpretation is sufficient by itself. Authorization must be checked at grant time and recorded with the grant/audit event. An administrator cannot grant this authority to themselves. Exact delegation scope, expiry, revocation, and behavior when the Mission Owner or administrator loses access remain implementation-level details to specify.

#### 2. PR and contribution intake — hybrid association

The Integration Resolver should automatically discover and associate contributions when reliable metadata and Git history support the relationship. Signals may include explicit Work Item identifiers in branch names, commit messages, PR metadata, recorded Workflow Run/Operation provenance, and known branch ancestry.

- Confident, unambiguous associations may be proposed automatically with their evidence.
- Ambiguous, conflicting, or missing associations require user confirmation.
- The system must not silently assign a PR or commit to a Work Item based only on a weak heuristic.
- Preserve the distinction between a discovered association and a user-confirmed association.
- PR creation remains outside automatic behavior in the first generation.

The detailed metadata conventions, confidence/ambiguity rules, and supported merge/cherry-pick constraints remain to be specified.

#### 3. Execution isolation — hybrid local restrictions and containers

Use a hybrid execution model:

- Trusted, narrowly scoped operations may run as local processes under the Execution Gateway with canonical path checks, allowlisted tools, minimal environment, bounded input/output, time/resource limits, and explicit policy.
- Untrusted or insufficiently trusted project code (including package scripts, test runners, build scripts, and arbitrary repository-provided executables) must run inside an isolated container with restricted mounts, minimal credentials, bounded resources, and network access disabled or explicitly allowlisted by policy.
- Trust classification must be deterministic and based on provenance/policy, never solely on an agent's claim.
- If the required isolation boundary is unavailable, the Gateway must not silently downgrade an untrusted execution to an unrestricted host process; it must block or request an explicitly supported safe alternative.
- Containerization is an isolation layer, not proof of complete security. Host filesystem exposure, Docker socket access, capabilities, mounts, network, and image provenance must be constrained.

#### 4. Parallelism — hierarchical concurrency limits

Concurrency must be bounded at multiple scopes:

- Global runtime limit.
- Per-Mission limit.
- Per-provider/model limit.

Limits are configurable and enforced centrally by the scheduler/provider admission path. The scheduler must account for provider rate limits, available resources, Mission priorities, and token reservations. Concurrency limits do not grant additional token budget: all parallel LLM calls still reserve against the same authorized Mission phase allowance atomically. A limit at any applicable scope takes precedence; work waits or is rescheduled rather than bypassing the limit.

Exact default numeric concurrency values and fairness/priority policy are not yet fixed and must be configurable rather than invented as product guarantees.

#### 5. Technical review — layered, risk-adaptive review

Review combines three layers:

1. Deterministic checks: formatting, linting, type checking, tests, static checks, contract checks, and Git/diff inspection as applicable.
2. An independent reviewer agent that receives the requirements, relevant source/diff, and evidence, and reports findings without relying on the implementation agent's self-assessment.
3. Additional tests and deeper verification selected according to deterministic risk classification and the impact of the change.

The reviewer agent is advisory and cannot approve its own findings, grant operational permissions, or replace the Integration Resolver's global candidate-branch assessment. Risk determines review depth; required security and acceptance checks cannot be skipped merely because an agent recommends doing so. Findings must link to source/evidence and be independently verified where practical.

#### 6. Audit history — permanent critical events and retained operational data

Use two retention classes:

- **Critical audit events** are permanent and append-only, including grants and grant authorization, permission/delegation changes, approvals and revocations, protected operations, security-relevant policy decisions, integration/promotion decisions, and audit-significant state transitions. The runtime must not offer ordinary deletion or mutation of these records.
- **Operational data** such as transient execution details, verbose diagnostics, temporary artifacts, and superseded intermediate state may follow a configurable retention and archival policy.

Archival or expiry of operational data must not erase critical audit events, break required provenance, or make retained decisions unverifiable. Where operational payloads are archived or expired, preserve the necessary identifiers, hashes, timestamps, relationships, and audit references. Exact retention periods, archive format, and privacy/deletion handling remain to be specified.

#### 7. Contract validation — Zod internally, JSON Schema externally

Zod is the canonical source for runtime TypeScript contracts and validation inside the JARVIS codebase. Export JSON Schema representations for external interoperability, including MCP/client integrations and documentation.

- Internal application/domain boundaries validate with the canonical Zod schemas.
- Exported JSON Schema is generated from those schemas rather than maintained as a divergent second source of truth.
- Contract exports must be versioned and tested for compatibility.
- Unsupported Zod constructs or export limitations must be detected; do not silently publish an incomplete schema.
- External inputs are validated again at the Application API boundary even if the client claims to have validated them.

#### Consequences for implementation

These decisions affect the permission model, Execution Gateway, scheduler, review pipeline, audit storage, and contract tooling. They must be reflected in domain contracts, persistence constraints, threat model, and acceptance tests before implementation is considered complete.

### Proposed, not yet finalized

- Specific model-routing and context-compaction algorithms.
- Detailed project role/permission administration UX, delegation scope, expiry/revocation, and loss-of-access behavior for Mission grant authorization.
- Exact concurrency defaults/fairness policy, trust-classification rules and container profiles, audit retention periods/archive format, and PR association metadata/ambiguity rules.
- Exact technical acceptance criteria and schemas for Integration Resolver findings and contribution provenance.
- Detailed domain contracts, persistence schema, state transitions, and threat model after implementation-level design review.

### Open decisions

- Exact project-admin delegation lifecycle and revocation semantics, including behavior when Mission ownership or project access changes.
- Detailed PR intake metadata conventions, ambiguity thresholds, and supported merge/cherry-pick constraints.
- Exact concurrency defaults and fairness/priority rules; deterministic trust-classification rules and container profiles; audit retention periods and archive format.
- Final domain contracts, persistence schema, state transitions, and threat model after implementation-level design review.

### Implementation status — 2026-11-23

Built on branch `feat/approval-gate-foundation`; Generation 1 is preserved at tag `legacy-0.6.0-gen1`.
The requirement-to-test matrix lives in [`../TESTING.md`](../TESTING.md) and is enforced by a test.

| Stage                                     | Status                                                                    | Where                                               |
| ----------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------- |
| 1 Architecture, threat model, invariants  | done                                                                      | this document, [`THREAT-MODEL.md`](THREAT-MODEL.md) |
| 2 Domain contracts and state machines     | done                                                                      | `src/domain`                                        |
| 3 Persistence and repositories            | done                                                                      | `src/persistence` (migrations 1–4)                  |
| 4 Policy and operation-specific approvals | done                                                                      | `src/policy`, `src/approval`                        |
| 5 Execution Gateway and isolation         | done; Docker profile unit-tested, **not exercised against a live daemon** | `src/gateway`                                       |
| 6 Project Intelligence                    | done (deterministic scan, revalidation, selective retrieval)              | `src/knowledge`                                     |
| 7 Workflow runtime and recovery           | done                                                                      | `src/runtime`, `src/requirements`                   |
| 8 MCP and CLI adapters                    | done                                                                      | `src/mcp`, `src/cli`                                |
| 9 Git, worktrees, Integration Resolver    | done (deterministic assessment; no LLM interpretation yet)                | `src/git`, `src/integration`                        |
| 10 AI Runtime and token budgets           | done; Ollama and Claude Code adapters tested with fakes only              | `src/ai`, `src/budget`, `src/runtime/scheduler.ts`  |
| 11 Adversarial tests, CI, docs            | done                                                                      | `tests`, `docs`                                     |

### Confirmed by the user — channel intake (2026-11-23)

- Task intake from chat channels (WhatsApp first) is an **integration capability**, not part of the Workflow Runtime core.
- The interpreting model is pluggable behind `ProviderAdapter`; Ollama and Claude Code are examples, not dependencies.
- Messages are untrusted data. A model may interpret and propose; a human confirms; the normal Mission,
  budget, approval and gateway flow then applies. Proposals are the only automatic outcome.

### Confirmed by the user — testing (2026-11-23)

- Coverage is by behavior and risk. 250–400 tests is a planning estimate, not a target.
- Done means every critical requirement has automated evidence (matrix in `docs/TESTING.md`), across unit,
  integration, end-to-end, adversarial and recovery levels.

### Still open (implementation-level)

- Concurrency defaults and fairness/priority beyond priority-then-FIFO.
- Container profiles beyond the single locked-down default; image provenance beyond digest pinning.
- Audit retention periods and archive format (critical events are never deleted; operational data policy is not implemented).
- Delegation UX beyond owner-created, expiring, revocable delegations.
- Whether JARVIS may later resolve simple low-risk tasks automatically (today: propose only).
- LLM-assisted interpretation inside the Integration Resolver; PR metadata conventions beyond explicit `wi_…` ids.
- Mission scope versioning UI and automatic budget estimation (grants are recorded and enforced; estimates are human-entered).

### Update — 2026-11-23 (planning gate, learning journal, retention)

- **Planning gate** (`src/planning`): a fixed category checklist generates the questions (MATERIAL vs LOW); plans must be
  complete (verification per step, risks with mitigation, tests, rollback, no cycles) and a human approves plan and
  estimate. Execution cannot start without it. Material questions can only be answered by a human; LOW ones may be settled
  by a recorded convention.
- **Learning journal** (`src/notes`): one Markdown note per Work Item, regenerated from recorded facts (decisions with their
  reasons, plan, what ran, real test evidence, token cost, an explanation script and likely questions). Default folder
  `~/Jarvis-Notas/<project>`.
- **Estimation**: complexity-based with a 25% margin, calibrated by actual-versus-reserved history (needs 5+ samples).
- **Retention** (`src/persistence/retention.ts`): archives operational payloads keeping hashes; audit, ledgers, plans and
  live runs are untouched.
- **Operations**: `approvals --watch`, `report` (markdown change report).
- **Run guard**: changes and executions are accepted only for a RUNNING run of the same Work Item (closes a bypass of the plan gate).
- **Plan step tracking**: steps are marked done only with successful operations of a declared type inside declared paths; review needs every step proven; edits outside the approved plan force an amended, human-approved plan.
- **Control files**: `.jarvis/` is not writable through the gateway (an agent could otherwise grant itself trust).
- **Pilot** (23/11): a real Claude Code session, with built-in tools disabled, completed edit, test, step marking and was correctly refused on `.jarvis/config.json` and held at the commit approval gate (cost under US$0.01).
- Closed from "Still open": retention of operational data; automatic budget estimation. Still open: archive format beyond
  in-place hashing.

### Update — 2026-11-24 (fix loop breaker)

- Inspired by Superpowers' systematic-debugging ("three failed fixes: question the cause, not the patch").
- A failed fix attempt is a TEST_RUN that FAILED right after a non-test FILE_EDIT, read from the execution ledger. A passing
  test run resets the count. At 3 in a row, edits to non-test files are denied with `FIX_LOOP_STOP:3`; test edits and test runs
  stay open so the cause can be investigated.
- Only a newer **human-approved** plan releases it (the count restarts from that approval), so the agent cannot talk its way
  out. The limit is a constant (`MAX_FAILED_FIX_ATTEMPTS`), not configuration, so a project cannot weaken it. Requirement: `R-QUALITY-06`.
