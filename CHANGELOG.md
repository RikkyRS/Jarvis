# Changelog

## Unreleased

- Delegated autonomy (`src/autonomy`): the human sets, once, how much JARVIS may do without asking (`jarvis autonomy set INTERMEDIATE`). At INTERMEDIATE a plan whose operations are all LOW or MEDIUM risk is approved and started by the delegation (`jarvis autonomy tick`); commit, push, merge and anything HIGH or CRITICAL still wait for the human. Optional automatic confirmation of cited IN_SCOPE client requests. Every automatic decision is attributed to the `autonomy` actor with the fingerprint of the configuration that allowed it. Read-only MCP `jarvis_autonomy_status`.
- Dependencies: zod 4 (fixes a high-severity advisory), vitest 5, eslint 10, actions v7; `npm audit` clean.

- Engineering method in the plan contract: certainties (with evidence), proposals and doubts (an open doubt blocks approval), an optional impact matrix (a row without a decision blocks), and a mandatory diagnosis for bug-fix plans.
- Blind review (`src/review/blind.ts`, `jarvis review blind`): sees only the approved plan, criteria and code; deterministic check for steps whose paths were never touched; verdict computed from findings; advisory.
- Cycle drafts (`jarvis cycle commit|pr`) from the approved plan; documentation drift (`jarvis docs-drift`).
- Claude Code plugin (`plugin/`): `/jarvis:plan`, `dev`, `review`, `cycle`, `toc`, tested against the real MCP tools and CLI. Method inspired by the personal harness of Gabriel (GitHub: Gabrieltupi), used with permission.

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
