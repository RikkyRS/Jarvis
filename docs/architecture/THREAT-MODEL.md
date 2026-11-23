# JARVIS Generation 2 — Threat model

Scope: the local runtime (one process, SQLite, a human operator, AI clients over MCP, optional chat channels).
Network-shared deployment is out of scope until identity, tenancy and secret management are designed.

## Trust boundaries

| Actor / input                                   | Trust                         | Can do                                                                       |
| ----------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------- |
| Human at the CLI                                | trusted principal (`human`)   | approve, reject, grant tokens, confirm proposals, edit `.jarvis/config.json` |
| AI client over MCP                              | untrusted principal (`agent`) | read state, _request_ operations                                             |
| LLM output, prompts, tool arguments             | untrusted data                | nothing on its own                                                           |
| Repository content (code, hooks, scripts, docs) | untrusted data                | nothing on its own; scripts run only under isolation policy                  |
| Chat messages (WhatsApp etc.)                   | untrusted data                | become a _proposal_ a human may confirm                                      |

## Threats and controls

| #   | Threat                                                                             | Control                                                                                                                                                  | Evidence                               |
| --- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| T1  | Agent approves its own operation, or forges an approval flag                       | Only a `human` principal can decide; MCP exposes no approve tool                                                                                         | R-APPROVAL-01, R-MCP-01                |
| T2  | Approval replayed or reused for different content                                  | Single use; bound to operation id, project, run, actor, type, canonical target and parameter fingerprint; commit also re-hashes the staged diff          | R-APPROVAL-02/03/06, R-GIT-03          |
| T3  | Prompt injection in repository files or chat messages                              | Content is data; classifier output is schema-validated and can only yield a proposal; humans confirm; messages never reach the gateway                   | R-INTAKE-01                            |
| T4  | Confused deputy: an agent claims its code is trusted                               | Trust is decided by human-owned config; the request's `trust` field is overwritten                                                                       | R-ISO-01                               |
| T5  | Malicious package scripts / test runners on the host                               | Untrusted code runs only in a container (no network, read-only root, dropped caps, no env, digest-pinned image) or is blocked; never silently downgraded | R-ISO-01/02                            |
| T6  | Repository hooks execute arbitrary code during git operations                      | Hooks path is redirected; `--no-verify`                                                                                                                  | R-GIT-01                               |
| T7  | Path traversal and symlink escape                                                  | Canonicalization against the real project root, NUL rejected                                                                                             | R-PATH-01/02                           |
| T8  | Command and option injection                                                       | No shell; executable allowlist; ref names validated and cannot start with `-`                                                                            | R-GIT-02                               |
| T9  | Secret exfiltration through environment or knowledge                               | Child processes get a minimal environment; knowledge store rejects secret patterns; audit holds identifiers, not message content                         | R-ENV-01, R-SECRET-01                  |
| T10 | Tampering with the audit trail                                                     | Append-only triggers plus a hash chain verified on demand and at startup status                                                                          | R-AUDIT-01, R-RECOVERY-02              |
| T11 | Budget overspend through concurrency or loops                                      | Atomic reservation in `BEGIN IMMEDIATE`; loop and per-run caps; immutable grant ledger                                                                   | R-BUDGET-01/02, R-LOOP-01, R-LEDGER-01 |
| T12 | Privilege escalation through delegation                                            | Admin grants need the permission _and_ an owner delegation; nobody edits their own permissions                                                           | R-GRANT-01                             |
| T13 | Promoting something other than what was validated                                  | Report bound to the exact candidate SHA; merge re-verifies the source SHA                                                                                | R-INTEGRATION-01                       |
| T14 | False completion after failures                                                    | Completion is derived from the execution ledger and needs a human                                                                                        | R-RUN-01                               |
| T15 | Forged webhook                                                                     | HMAC-SHA256 verified in constant time before parsing                                                                                                     | R-INTAKE-02                            |
| T17 | Agent rewrites `.jarvis/config.json` to grant itself trust, or edits state/journal | Gateway denies FILE_EDIT and GIT_STAGE on `.jarvis/` (except worktrees under `.jarvis/wt/`)                                                              | R-PATH-03                              |
| T16 | Interrupted side effects and crashes                                               | Durable state and checkpoints; interrupted runs move explicitly to PAUSED                                                                                | R-RECOVERY-01                          |

## Residual risks (honest limits)

- A container reduces risk; it is not proof of safety. Host kernel and Docker daemon vulnerabilities remain.
- `trustedProject: true` runs project scripts on the host. Set it only for repositories you wrote or fully audited.
- The OS user running JARVIS can edit the SQLite file directly. The hash chain _detects_ that; it cannot prevent it.
- Approvals show parameters, not a semantic review of what a script does. The human must read what they approve.
- Webhook transport (TLS, exposure) is the host's responsibility; JARVIS only verifies signatures.
- Model quality is outside the guarantee: a provider may return a wrong but well-formed proposal. Humans confirm.
- There is no financial cost accounting, by decision; only token counts.
