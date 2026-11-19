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

## Data architecture

A clean schema baseline is allowed; legacy SQLite data is not a compatibility requirement. Separate operational state (workflows, checkpoints, locks, approvals, executions, events), project knowledge (versioned Markdown or structured documents with provenance), configuration, and secrets. SQLite is suitable for the initial local runtime. Knowledge files must be written atomically. Secrets must not enter knowledge documents, approval hashes, or ordinary logs.

A future shared deployment requires explicit identity, authentication, authorization, tenant isolation, and secret management. The local server must not simply be exposed to a network.

## Security baseline

Threats include prompt injection in repository content, malicious MCP clients, confused-deputy behavior, forged/replayed approvals, command injection, path traversal and symlink escapes, malicious package scripts, secret exfiltration, concurrency races, and interrupted side effects. Start local-only, restrict project roots, minimize inherited environment, bound input/output, allowlist tools, and use OS-level process isolation where available.

## Git policy

Read-only inspection may be automatic. Stage only reviewed paths. Commit and push each require distinct approval. Push verifies remote, branch, and expected HEAD. Force push is blocked by default. No automatic merge or PR creation in the first generation. Verify and record resulting SHAs after side effects.

## Implementation sequence

1. Architecture, threat model, domain language, invariants.
2. Clean domain contracts and workflow state machine.
3. Persistence schema and transactional repositories.
4. Policy engine and operation-specific approval lifecycle.
5. Execution Gateway and process isolation.
6. Project Intelligence and durable knowledge lifecycle.
7. Workflow runtime and recovery.
8. MCP and CLI adapters.
9. Git, test execution, and other tools.
10. Adversarial tests, CI, documentation, and release.

Each stage needs acceptance criteria and tests before dependent work begins.

## Compatibility policy

Legacy 0.6.x code, database, and local `.harness/` state are reference material only. Contracts, module boundaries, schema, CLI, and MCP may change incompatibly. Obsolete capabilities may be removed and old local operational data may be discarded. Any destructive local reset must be explicit and documented. Public Git history and `main` remain preserved during development.
