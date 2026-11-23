# Changelog

## Unreleased

- Docker isolation is checked against a live daemon in CI (job `docker-isolation`). It found a real bug: the container user is now the host uid instead of a fixed 1000.
- Ollama adapter tested over real HTTP; opt-in live tests for Ollama and Claude Code. Clearer error when Claude Code cannot be started on Windows (use the native `claude.exe`).
- Integration Resolver: advisory LLM interpretation (`src/integration/interpret.ts`), path-checked, severity capped below HIGH, never part of promotion.
- Per-project contract memory (`src/contract`): CONTRACT, SCOPE and HISTORY documents (.md, .txt, .pdf via pdftotext), added only by a human, versioned with only the current version consulted, isolated per project, secrets refused. Optional: projects without a contract work. Read-only MCP search (`jarvis_project_contract`).
- Request triage against the contract (`src/contract/triage.ts`): REPEATED, IN_SCOPE, OUT_OF_SCOPE or UNCLEAR, always with cited evidence; without it the verdict is UNCLEAR and a human decides.
- Intake: each proposal carries its scope verdict; draft replies for the human to send (JARVIS has no way to send).
- CLI: `contract add|list|find`, `inbox add|process`, `digest`, `proposal reply`, `privacy`. Models come from the environment and are local by default (`JARVIS_OLLAMA_MODEL`); Claude Code only with `JARVIS_ALLOW_CLAUDE=1`.
- Privacy: `.jarvis/` is self-ignoring for Git and owner-only on POSIX; `jarvis privacy` checks where client data can go. See docs/PRIVACIDADE.md.
- Docs: Generation 1 to 2 guide (PT-BR), test guide generated from real results, CLI demo.

## 1.0.0-alpha.0 — Generation 2 foundation

Clean redesign; Generation 1 (0.6.x) removed and preserved at tag `legacy-0.6.0-gen1`.

- Zod domain contracts, workflow/work-item state machines.
- Deterministic policy engine (config can only tighten).
- Operation-specific, single-use, human-only approvals bound to a fingerprint.
- Append-only, hash-chained audit log.
- Execution Gateway: path canonicalization, replay protection, approval consumption, isolation enforcement, evidence required for success.
