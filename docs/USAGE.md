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

Run it from (or point `cwd` at) the project you want JARVIS to govern. Tools: `jarvis_status`,
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
