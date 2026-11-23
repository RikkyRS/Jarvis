# Os testes do JARVIS, por área

Este arquivo substitui o guia antigo (que explicava os 57 testes da Geração 1). Ele é **gerado dos testes reais** da Geração 2 por `scripts/gen-test-guide.mjs`: **191 testes, 188 passando, 3 ignorados**. Os ignorados são verificações opt-in que dependem de Docker, Ollama ou Claude Code reais.

Como ler: cada título descreve o comportamento garantido. Os que começam com `[R-...]` são **requisitos críticos** da matriz em [`TESTING.md`](TESTING.md); `tests/unit/traceability.test.ts` falha se um requisito ficar sem teste.

Rodar tudo: `npm test`. Rodar contra os backends reais:

```bash
JARVIS_OLLAMA_MODEL=qwen2.5:3b npm test                          # Ollama de verdade
JARVIS_CLAUDE_LIVE=1 npm test                                    # Claude Code de verdade (poucos tokens do seu plano)
JARVIS_DOCKER_IMAGE="node:22-alpine@sha256:<digest>" npm test    # isolamento com Docker real (já roda no CI)
```

| Área | Testes |
|---|---:|
| `e2e/cli-lifecycle` | 1 |
| `e2e/full-flow` | 10 |
| `e2e/protected-paths` | 2 |
| `integration/adapters` | 8 |
| `integration/ai-runtime` | 15 |
| `integration/container-profile` | 2 |
| `integration/contract` | 15 |
| `integration/docker-live` | 1 |
| `integration/domain-budget` | 13 |
| `integration/engineering-method` | 12 |
| `integration/gateway` | 18 |
| `integration/git` | 10 |
| `integration/intake` | 11 |
| `integration/intake-triage` | 5 |
| `integration/interpretation` | 6 |
| `integration/plan-steps` | 6 |
| `integration/planning-notes` | 12 |
| `integration/privacy` | 3 |
| `integration/providers-http` | 2 |
| `integration/providers-live` | 2 |
| `integration/resolver-knowledge` | 12 |
| `recovery/recovery` | 6 |
| `unit/domain` | 7 |
| `unit/plugin` | 4 |
| `unit/requirements` | 5 |
| `unit/traceability` | 3 |
| **Total** | **191** |

---

## `e2e/cli-lifecycle` (1)

Ciclo de vida inteiro dirigido só pela CLI humana

- [R-E2E-02] work -> questions -> plan -> approval -> run -> agent work -> review -> delivery -> reopen

---

## `e2e/full-flow` (10)

Fluxos completos: Mission, run, edição, teste, commit aprovado, revisão, entrega e reabertura

- [R-E2E-01] completes a full flow with evidence, and reopens with preserved context
- [R-RUN-01] a failed operation can never be reported as completed
- refuses to submit a run that has no evidence at all
- only RUNNING runs accept operations
- [R-APPROVAL-01] an agent cannot approve its own operation
- [R-APPROVAL-02] an approval cannot authorize modified content
- [R-ISO-01] an agent claiming trust gets none: untrusted project code is blocked without a container
- [R-GATE-01] critical operations are blocked and audited, never executed
- [R-PATH-01] path traversal through file operations is denied
- an approved operation id cannot be replayed after it ran

---

## `e2e/protected-paths` (2)

Tentativas de escrever em arquivos de controle do JARVIS (`.jarvis/`)

- [R-PATH-03] an agent cannot edit its own permissions, state, notes or knowledge
- reading is allowed, and worktrees under .jarvis/wt keep working

---

## `integration/adapters` (8)

Adaptadores CLI e MCP: o que o agente pode e não pode pedir

- [R-MCP-01] exposes request/read tools only: no approve, grant, confirm or policy tool
- [R-MCP-02] an agent request needing approval stays pending until a human approves on the CLI
- returns errors as data and validates input
- serves knowledge with validity
- creates work, shows pending approvals with full detail and honours a declined prompt
- manages budget, audit and unknown commands
- [R-CONTRACT-01] exports JSON Schema from Zod and matches the committed, versioned snapshot
- detects unsupported constructs instead of publishing a partial contract

---

## `integration/ai-runtime` (15)

Runtime de IA: roteador, orçamento, loops, scheduler, provedores e perfil de isolamento Docker

- [R-BUDGET-01] never calls the provider when the authorized budget would be exceeded
- [R-BUDGET-01] blocks everything with no grant
- [R-BUDGET-02] parallel calls cannot consume the same reserved balance
- records provider-reported usage as ACTUAL and missing usage as UNAVAILABLE
- keeps a conservative charge and surfaces the error when a provider fails
- [R-LOOP-01] detects unproductive loops and caps output
- downgrades model tier when the budget is restricted
- [R-CONC-01] enforces global, per-mission and per-model limits together
- serves higher priority first and releases slots on failure
- rejects invalid limits
- dedupes, trims optional context and never drops mandatory rules
- Ollama sends a JSON schema, reports usage and is loopback-only
- Claude Code runs text-only: no tools, no MCP, no session, prompt on stdin
- [R-ISO-02] builds a locked-down docker profile
- [R-ISO-02] rejects unpinned images, env vars and cwd outside the workspace

---

## `integration/container-profile` (2)



- [R-ISO-02] never runs as root and defaults to an unprivileged id
- [R-ISO-02] the user is part of the locked-down argument list and can be overridden

---

## `integration/contract` (15)



- [R-CONTRACT-02] only a human can add documents; an agent is refused
- [R-CONTRACT-02] a new version replaces the one consulted; the old is kept and audited
- [R-CONTRACT-03] a project never sees another project's contract
- [R-CONTRACT-03] refuses documents that contain secrets
- retrieves only the few clauses that match, with their clause label
- splits documents into clauses and bounds their size
- reads Markdown and text, rejects other file types
- [R-CONTRACT-04] a repeated complaint is recognized with the history entry as evidence
- [R-CONTRACT-04] new work outside the contract is flagged with the clause that excludes it
- [R-CONTRACT-04] a verdict with an invented or mismatched citation is downgraded to UNCLEAR
- [R-CONTRACT-04] with nothing relevant on file the model is not called and no tokens are spent
- [R-CONTRACT-04] hostile text in the request is data and cannot force a verdict
- [R-CONTRACT-05] a project with no contract works: no model call, request goes to the normal flow
- [R-CONTRACT-05] with only a history (no contract) repeats are still detected, scope is not guessed
- malformed model output degrades to UNAVAILABLE

---

## `integration/docker-live` (1)

Isolamento contra um daemon Docker real (roda no CI; local só com Docker ligado)

- (ignorado) runs code with no network, no host environment and a read-only root

---

## `integration/domain-budget` (13)

Projetos, Missions, Work Items e orçamento de tokens

- [R-STATE-02] runs the work item lifecycle and keeps context on reopen
- rejects invalid transitions and stale versions
- recovers interrupted runs explicitly to PAUSED
- only humans create projects; nobody edits their own permissions
- requires an owner initial grant and separates phases
- [R-GRANT-01] needs BOTH permission and owner delegation for admin grants
- rejects delegation expiry, self-delegation and non-owner delegation
- [R-BUDGET-03] applies warning, restriction and hard stop thresholds
- never lets concurrent reservations exceed the allowance
- settles in-flight calls beyond the limit and records estimates honestly
- [R-LEDGER-02] keeps unavailable usage as UNAVAILABLE and reconciles without erasing
- [R-LEDGER-01] ledgers are immutable
- [R-BUDGET-04] rejects thresholds that weaken the hard stop

---

## `integration/engineering-method` (12)



- [R-METHOD-01] a bug-fix plan cannot be approved without showing the cause
- [R-METHOD-02] an open doubt blocks the plan; resolving it unblocks
- [R-METHOD-02] a certainty needs evidence, otherwise it is not a certainty
- [R-METHOD-03] an impact-matrix row without a decision blocks the plan
- [R-METHOD-04] finds, without any model, a planned step whose paths were never touched
- [R-METHOD-04] the verdict is computed from the findings, never taken from the model
- [R-METHOD-04] the reviewer is blind: it never receives decisions, conversation or history
- [R-METHOD-04] findings that cite an unknown plan item or an unchanged file are dropped
- [R-METHOD-04] with the model unavailable only the deterministic checks run
- [R-METHOD-05] the commit message is type(scope): description, short and derived from the plan
- [R-METHOD-05] the PR description lists what the plan states and nothing invented
- [R-METHOD-06] separates what still holds from what aged, and says what it could not check

---

## `integration/gateway` (18)

Execution Gateway: política, caminhos, aprovação, replay, evidência, ambiente

- runs allowed operations and records evidence
- [R-GATE-01] blocks critical operations even if an approval exists
- [R-PATH-01] denies path traversal and absolute escapes
- [R-PATH-02] denies symlink escapes
- [R-REPLAY-01] denies replay of an executed operation id
- denies requests for another project
- [R-EVIDENCE-01] fails success claims that carry no evidence
- reports handler exceptions as FAILED
- [R-ISO-01] never runs untrusted project code without a container
- [R-APPROVAL-05] denies a high-risk operation without approval
- denies when the approval is still pending
- [R-APPROVAL-06] executes once with a human approval and refuses replay of the approval
- [R-APPROVAL-01] rejects approval by an agent or system principal
- [R-APPROVAL-02] invalidates the approval if parameters, target or actor change
- [R-APPROVAL-04] expires approvals
- [R-APPROVAL-07] does not burn the approval when execution is refused before running
- rejected approvals cannot be used
- [R-AUDIT-01] is append-only and detects tampering

---

## `integration/git` (10)

Git e worktrees: hooks, push, commit aprovado, perda de trabalho

- inspects state with evidence
- [R-GIT-03] stages, then commits only the exact approved diff
- [R-GIT-01] never runs repository hooks
- [R-GIT-02] pushes only when remote, branch and HEAD match, and verifies the remote
- [R-GATE-01] refuses to force push by policy
- [R-WORKTREE-01] creates and safely removes an isolated worktree
- merges an exact, verified source commit with approval
- edits atomically with optimistic concurrency and reads back
- runs trusted tests on the host and reports the real exit code
- [R-ENV-01] does not leak the parent environment to child processes

---

## `integration/intake` (11)

Mensagens externas (WhatsApp): são dado não confiável e viram proposta

- groups related messages into ONE proposal that a human must confirm
- [R-INTAKE-01] treats message text as data: injection cannot create or execute anything
- is idempotent for webhook retries and ignores unknown senders
- fails closed on invalid or fabricated model output
- does not raise proposals for questions and chat
- detects a duplicate of an existing Work Item and merges only on a human's choice
- stops and checkpoints when the token budget is exhausted
- lets a human confirm a proposal from the CLI without any AI provider
- scores similarity independent of accents and short words
- [R-INTAKE-02] verifies the webhook signature in constant time and rejects forgeries
- extracts text messages only

---

## `integration/intake-triage` (5)



- [R-INTAKE-03] a repeated complaint arrives as a proposal tagged REPEATED with the history as evidence
- [R-INTAKE-03] a triage failure never blocks the proposal
- [R-INTAKE-04] a reply is only a draft stored for the human; there is no way to send it
- [R-INTAKE-04] the digest counts what waits for the human
- [R-CONTRACT-05] works as before: proposal created, triage skipped, no extra model call

---

## `integration/interpretation` (6)

Interpretação do Resolver por LLM: consultiva, sem poder de decisão

- [R-INTERP-01] is advisory: it never changes the report, its hash or promotability
- [R-INTERP-02] drops observations that cite paths absent from the report
- [R-INTERP-02] the model can never raise HIGH: anything above INFO is capped at MEDIUM
- [R-INTERP-02] malformed output or a provider failure yields UNAVAILABLE, not an error
- [R-INTERP-03] hostile commit text is sent as data and cannot alter the outcome
- [R-INTERP-03] spends budget only through the AI runtime and is blocked without one

---

## `integration/plan-steps` (6)

Passos do plano comprovados por operações reais

- [R-RUN-02] changes and executions need a RUNNING run of the same Work Item
- [R-PLAN-05] review needs every step proven by real, matching operations
- [R-PLAN-05] evidence from another Work Item or a failed operation does not count
- [R-PLAN-06] changes outside the approved plan are detected and need an amended, approved plan
- [R-PLAN-07] a step that edits files must declare the paths it may touch
- CLI shows progress and marks steps; the journal reflects it

---

## `integration/planning-notes` (12)

Planning gate e diário de aprendizado

- [R-PLAN-01] walks the whole checklist, skips what is known, never re-asks, only humans answer
- only assumes conventions for low-impact questions, and says so
- [R-PLAN-02] lists every reason a plan is not ready
- [R-PLAN-03] execution cannot start without a human-approved, current plan that fits the budget
- [R-PLAN-04] estimates from complexity with a margin and calibrates on real history
- [R-NOTES-01] writes an explainable note from facts at plan approval, completion and delivery
- is idempotent, writes a project overview and redacts anything that looks like a secret
- [R-NOTES-02] a journal failure never blocks or undoes the real work
- [R-RETENTION-01] archives operational data only: audit, ledgers, plans and live runs are untouched
- CLI drives questions -> answers -> plan -> approval
- CLI approvals --watch announces new requests; retention apply works
- [R-MCP-03] an agent can ask questions and draft a plan but can never approve it

---

## `integration/privacy` (3)



- [R-PRIVACY-01] the state directory can never be committed, even if the project forgot to ignore it
- [R-PRIVACY-02] the report flags a cloud model and an exposed state directory, and is OK when local
- [R-PRIVACY-02] the report warns about old processed messages kept as text

---

## `integration/providers-http` (2)

Adaptador Ollama sobre conexão HTTP real

- [R-ADAPTER-01] speaks the /api/chat wire format and reads usage back
- [R-ADAPTER-01] turns HTTP errors and empty bodies into explicit failures

---

## `integration/providers-live` (2)

Ollama e Claude Code reais (opt-in; ignorados no CI)

- (ignorado) returns schema-shaped JSON and reports real token usage
- (ignorado) answers in text-only mode and reports usage

---

## `integration/resolver-knowledge` (12)

Integration Resolver e base de conhecimento do projeto

- [R-INTEGRATION-01] promotion is bound to the exact validated SHA
- flags overlapping files from different contributions
- does not guess associations from weak signals
- blocks when a deterministic check fails at the candidate SHA
- refuses to run checks on a dirty or different checkout
- flags dependency and contract changes
- is reproducible: the same inputs give the same report hash
- rejects unresolvable refs and option-looking refs
- scans the stack with source-backed claims and revalidates them
- re-analyzes only impacted files on the next scan
- retrieves selectively and marks claims whose source changed
- [R-SECRET-01] never persists secrets and writes atomically

---

## `recovery/recovery` (6)

Recuperação: reinício, auditoria adulterada, corridas entre processos

- [R-RECOVERY-01] workflow state, approvals and budgets survive a process restart
- [R-RECOVERY-02] a tampered audit log is detected after restart
- refuses a database written by a newer runtime
- an interrupted knowledge write never corrupts the stored document
- [R-BUDGET-02] two connections cannot reserve the same remaining tokens
- [R-APPROVAL-03] racing processes consume one approval exactly once

---

## `unit/domain` (7)

Regras de domínio: política, estado e hash canônico

- [R-STATE-01] allows the happy path and rejects shortcuts
- treats completed, failed and cancelled as terminal
- lets a delivered or closed work item be reopened
- allows low/medium, requires approval for high, blocks critical
- [R-POLICY-01] lets project config tighten but never weaken
- defaults trust to UNTRUSTED and rejects unknown fields
- is key-order independent and rejects non-JSON values

---

## `unit/plugin` (4)



- [R-PLUGIN-01] declares five skills, each with a name and a description
- [R-PLUGIN-01] every MCP tool a skill mentions really exists
- [R-PLUGIN-01] every CLI command a skill tells the user to run really exists
- [R-PLUGIN-01] no skill grants an agent the power to approve

---

## `unit/requirements` (5)

Análise de requisitos

- [R-REQ-01] asks only material, unknown questions, deduplicated and grouped into one bounded round
- requires a single recommendation among real alternatives
- turns confirmed answers into explicit requirements, acceptance criteria and decisions (humans only)
- [R-BUDGET-05] implementation cannot start without a human and an authorized Execution Budget
- does not start execution on an exhausted budget

---

## `unit/traceability` (3)

Rastreabilidade: todo requisito crítico tem teste e vice-versa

- lists requirements
- every documented requirement has at least one automated test
- every cited requirement is documented
