# Using JARVIS

## Install and check

```bash
npm install
npm run ci          # typecheck, lint, tests, build
npm run build
```

Requires Node >= 22.5 and Git. Docker is only needed to run untrusted project code in isolation.

## Two channels, on purpose

| Channel      | Who         | Can                                                                     |
| ------------ | ----------- | ----------------------------------------------------------------------- |
| `jarvis` CLI | you (human) | approve/reject operations, grant tokens, confirm proposals, scan, audit |
| MCP server   | AI clients  | read state and request operations; **cannot approve anything**          |

```bash
node dist/cli/main.js status
node dist/cli/main.js work create "Fix totals" --objective "Totals are wrong" --accept "matches the source"
node dist/cli/main.js mission create
node dist/cli/main.js budget grant <missionId> PREPARATION 20000 --reason "discovery"
node dist/cli/main.js budget grant <missionId> EXECUTION 80000 --reason "approved scope v1"
node dist/cli/main.js approvals          # what is waiting, with full parameters
node dist/cli/main.js approve <id>       # shows the exact operation, then asks
node dist/cli/main.js audit verify
node dist/cli/main.js scan && node dist/cli/main.js know "test"
```

## Connect an AI client (Claude Code, Cursor, VS Code)

```bash
claude mcp add jarvis -- node /absolute/path/to/Jarvis/dist/cli/main.js mcp --client claude
```

Run it from (or point `cwd` at) the project you want JARVIS to govern. On Windows use a native path such as `C:/Users/you/Jarvis/dist/cli/main.js` in the config; a Git Bash style `/c/Users/...` path makes the server fail to start. In Claude Code the tools appear as `mcp__jarvis__jarvis_*`. Tools: `jarvis_status`,
`jarvis_list_work_items`, `jarvis_get_work_item`, `jarvis_request_operation`, `jarvis_resume_operation`,
`jarvis_pending_approvals`, `jarvis_budget_status`, `jarvis_project_knowledge`.

Typical loop for a high-risk operation (commit, push, merge, worktree removal):

1. The agent calls `jarvis_request_operation` and receives `APPROVAL_REQUIRED` with an `approvalId`.
2. You run `jarvis approvals` then `jarvis approve <id>` and read exactly what you approve.
3. The agent calls `jarvis_resume_operation`; the gateway re-verifies everything and executes once.

## Project configuration (human-owned)

`.jarvis/config.json`

```json
{
  "trustedProject": false,
  "allowedCommands": ["git", "node", "npm"],
  "approvalTtlMs": 900000,
  "requireApproval": ["FILE_EDIT"]
}
```

`trustedProject` defaults to `false`: tests and scripts are blocked unless a container runner is configured.
`requireApproval` can only make things stricter. Add `.jarvis/` to `.gitignore`.

## Lifecycle from the human CLI

```bash
jarvis work create "Fix totals" --objective "..." --accept "..."
jarvis plan questions <wi> ; jarvis plan answer ... ; jarvis plan submit ... ; jarvis plan approve <wi>
jarvis mission create --work-item <wi>
jarvis budget grant <mission> EXECUTION <tokens> --reason "plan v1"
jarvis run create <wi> && jarvis run ready <run>
jarvis run start <run> <mission>      # you start execution; needs approved plan + enough budget
# ... the agent works through MCP; steps are proven with jarvis_mark_step (or: jarvis plan done) ...
jarvis plan progress <wi>             # what is proven, and anything outside the plan
jarvis run submit <run>               # all steps proven, no change outside the plan
jarvis run complete <run>             # your review decision
jarvis work status <wi> DELIVERED     # later: REOPENED, with feedback kept
```

Changes and executions are only accepted for a RUNNING run of the same Work Item; reads work while the run is alive.

## Planning: get it right in one pass

Before any implementation the work goes through a gate:

```bash
jarvis plan questions <workItem>        # walks a fixed checklist (scope, data, security, compatibility, dependencies are MATERIAL)
jarvis plan answer <workItem> data "não altera esquema"
jarvis plan assume <workItem>           # accept stated conventions for LOW-impact questions, recorded as such
jarvis plan submit <workItem> plan.json # or an agent calls jarvis_submit_plan
jarvis plan check <workItem>            # lists every blocker
jarvis plan approve <workItem>          # you approve the plan AND its token estimate
```

Execution can only start (`startExecution`) with a human-approved plan that is still current (changing requirements
invalidates it) and an Execution allowance at least as large as the estimate. The estimate comes from step complexity plus
a 25% margin and recalibrates from the real usage history of this project.

## Learning journal

Every plan approval, completed run and Work Item transition regenerates a Markdown note from recorded facts. Default
folder: `~/Jarvis-Notas/<project>/` (override with `notesDir` in `.jarvis/config.json` or `JARVIS_NOTES_DIR`).
`INDEX.md` lists the notes and `PROJETO.md` is the stack overview from `jarvis scan`. Each note ends with a ~1 minute
script to explain the work and the questions you may be asked. Secrets are redacted and a journal failure never blocks
the work.

```bash
jarvis notes path
jarvis notes write <workItem>
```

## Maintenance

```bash
jarvis approvals --watch                        # announces new approval requests as they arrive
jarvis report <runId> --base main --head HEAD   # markdown change report, ready for a PR comment
jarvis retention apply --days 90                # archives old operational data; audit and token ledgers are never touched
```

## Channel intake (WhatsApp and others)

`Jarvis.intake(...)` ingests messages idempotently, groups related ones with an AI provider, flags duplicates of
existing Work Items and produces **proposals**. A human confirms or rejects each proposal; only then a Work Item
exists. Messages never become operations. Any `ProviderAdapter` works: `OllamaProvider` (loopback only),
`ClaudeCodeProvider` (headless, tools disabled), or your own. Use `verifySignature` + `parseWebhook` from
`src/intake/whatsapp.ts` in whatever HTTP endpoint receives the webhook (bind it to loopback or put it behind an
authenticated tunnel).

Current policy: JARVIS **proposes**; it does not resolve tasks automatically.

## Contracts

`npm run export-schemas` regenerates `schemas/contracts.json` from the Zod contracts. A test fails if the committed
snapshot drifts, so a contract change is always a deliberate, versioned diff.
