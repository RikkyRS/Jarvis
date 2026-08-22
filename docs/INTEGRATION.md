# Integration

JARVIS is the runtime/control layer.

The host (Cursor, VS Code, Claude Code, or other) is responsible for:

- editor/IDE
- provider and model
- credentials
- model interaction

JARVIS is responsible for:

- project and Cycle state
- evidence
- orchestration
- permissions
- tools
- validation
- auditability

Adapters invoke JARVIS. JARVIS does not manage the provider or model.

## Token-efficient Cursor workflow

**Run `jarvis brief` (or `jarvis resumo`) before exploring the repository each turn.**

```bash
jarvis brief
jarvis plan "implement pagination"
jarvis dev
jarvis memorize "uses pnpm and vitest"
jarvis close
```

Optional local backend (no GitHub required):

```bash
jarvis serve
curl "http://127.0.0.1:39217/brief?project=/path/to/project"
```

## Cursor

In any open project:

```text
jarvis planeje implementar paginação
```

or `/jarvis:plan implement pagination`. The agent must run the CLI and only then continue the conversation.

Cursor rules/skills live in `~/.cursor/` and enforce: brief first, no invented Cycle state.
