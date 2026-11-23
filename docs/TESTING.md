# Testing strategy

JARVIS is ready when its **requirements are proven**, not when a test count is reached. Quantity is not
coverage: 400 tests can still leave a critical vulnerability untested.

- The planning estimate for Generation 2 is **250–400 automated tests**. It is a planning figure, not a target.
- Every critical requirement has a stable ID (`R-…`) and at least one automated test whose title starts with
  `[R-…]`. `tests/unit/traceability.test.ts` fails the build if a requirement listed below has no test, or if a
  test cites an ID that is not listed here.
- Adding a requirement means adding a row here **and** a test; removing coverage is a visible diff.

## Levels

| Level                  | Purpose                                                                                                 | Location                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Unit                   | isolated rules: policy, state machine, canonical hashing, schemas                                       | `tests/unit`                                                |
| Integration            | modules together on real SQLite, real Git, real child processes                                         | `tests/integration`                                         |
| End to end             | complete flows: Mission → run → edit → test → approved commit → review → delivery → reopen              | `tests/e2e`                                                 |
| Security / adversarial | bypass attempts: forged or replayed approvals, tampered content, traversal, injection, hostile messages | across the suites above, tagged `adversarial` in the matrix |
| Recovery / resilience  | restarts, tampering, newer schema, interrupted writes, racing processes, exhausted budgets              | `tests/recovery`                                            |

## Requirement matrix

The six requirements the project is judged against come first.

| ID               | Requirement                                                                                                                   | Level       |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------- |
| R-BUDGET-01      | An LLM call can never exceed the authorized token budget                                                                      | integration |
| R-APPROVAL-01    | An agent cannot approve its own operation                                                                                     | adversarial |
| R-APPROVAL-02    | An old approval cannot authorize modified content                                                                             | adversarial |
| R-BUDGET-02      | Concurrent executions cannot consume the same reserved balance                                                                | recovery    |
| R-RUN-02         | Changes and executions need a RUNNING run of the same Work Item; a high-risk request on a non-running run creates no approval | adversarial |
| R-PLAN-05        | Review needs every plan step proven by real, matching, successful operations of the same Work Item                            | adversarial |
| R-PLAN-06        | Changes outside the approved plan are detected and need an amended, human-approved plan                                       | adversarial |
| R-PLAN-07        | A step that edits files must declare the paths it may touch                                                                   | unit        |
| R-RUN-01         | A failure during execution can never mark the task completed                                                                  | e2e         |
| R-INTEGRATION-01 | An integration cannot promote a branch other than the one validated                                                           | integration |
| R-APPROVAL-03    | Racing processes consume one approval exactly once                                                                            | recovery    |
| R-APPROVAL-04    | Approvals expire                                                                                                              | integration |
| R-APPROVAL-05    | A high-risk operation without approval is denied                                                                              | adversarial |
| R-APPROVAL-06    | An approval is single use, also across operation ids                                                                          | adversarial |
| R-APPROVAL-07    | A refused execution does not burn the approval                                                                                | integration |
| R-BUDGET-03      | Warning, restriction and hard-stop thresholds apply per phase                                                                 | integration |
| R-BUDGET-05      | Implementation cannot start without a human and an authorized Execution Budget                                                | integration |
| R-PLAN-01        | Clarification walks the full category checklist, skips what is known, never re-asks, only humans answer                       | integration |
| R-PLAN-02        | A plan lists every reason it is not ready (open questions, no tests, no rollback, cycles, bad paths, unmitigated risks)       | integration |
| R-PLAN-03        | Execution cannot start without a human-approved, current plan whose estimate fits the budget                                  | adversarial |
| R-PLAN-04        | Token estimates use complexity plus margin and calibrate on real history                                                      | unit        |
| R-NOTES-01       | A learning note is written from recorded facts at plan approval, completion and delivery                                      | integration |
| R-NOTES-02       | A journal failure never blocks or undoes real work                                                                            | recovery    |
| R-RETENTION-01   | Retention archives operational data only; audit, ledgers, plans and live runs are untouched                                   | recovery    |
| R-MCP-03         | An agent can ask questions and draft a plan but never approve it                                                              | adversarial |
| R-REQ-01         | Clarification asks only material, unknown questions, batched without repetition                                               | unit        |
| R-BUDGET-04      | Thresholds cannot be configured to weaken the hard stop                                                                       | unit        |
| R-LEDGER-01      | Grant ledger is immutable                                                                                                     | integration |
| R-LEDGER-02      | Unavailable usage stays unavailable; reconciliation never erases history                                                      | integration |
| R-GRANT-01       | Admin grants need both the permission and an owner delegation                                                                 | adversarial |
| R-LOOP-01        | Unproductive AI loops and oversized output are stopped                                                                        | integration |
| R-CONC-01        | Hierarchical concurrency limits hold                                                                                          | integration |
| R-GATE-01        | Critical operations are blocked and audited                                                                                   | adversarial |
| R-REPLAY-01      | An executed operation id cannot run twice                                                                                     | adversarial |
| R-EVIDENCE-01    | Success without evidence is reported as failure                                                                               | integration |
| R-PATH-01        | Path traversal is denied                                                                                                      | adversarial |
| R-PATH-03        | An agent cannot write JARVIS control files (config, state, journal, knowledge)                                                | adversarial |
| R-PATH-02        | Symlink escapes are denied                                                                                                    | adversarial |
| R-ENV-01         | Child processes never inherit the parent environment                                                                          | adversarial |
| R-ISO-01         | Untrusted project code never runs on the host; an agent's trust claim is ignored                                              | adversarial |
| R-ISO-02         | The container profile is locked down and pinned by digest                                                                     | integration |
| R-GIT-01         | Repository hooks never run on the host                                                                                        | adversarial |
| R-GIT-02         | Push verifies remote, branch and expected HEAD, then verifies the remote                                                      | adversarial |
| R-GIT-03         | A commit executes only the exact approved staged diff                                                                         | adversarial |
| R-WORKTREE-01    | Worktree removal never silently loses unintegrated work                                                                       | integration |
| R-AUDIT-01       | The audit log is append-only and tampering is detected                                                                        | adversarial |
| R-POLICY-01      | Project configuration can only tighten policy                                                                                 | unit        |
| R-STATE-01       | Only valid workflow transitions are possible                                                                                  | unit        |
| R-STATE-02       | Work Items keep their context when reopened                                                                                   | integration |
| R-SECRET-01      | Secrets never enter knowledge documents                                                                                       | adversarial |
| R-INTAKE-01      | Channel messages are untrusted data: injection cannot create or execute anything                                              | adversarial |
| R-INTAKE-02      | Webhook signatures are verified in constant time                                                                              | adversarial |
| R-MCP-01         | The MCP adapter exposes no approve, grant, confirm or policy tool                                                             | adversarial |
| R-MCP-02         | An agent request needing approval stays pending until a human approves                                                        | e2e         |
| R-CONTRACT-01    | JSON Schema is generated from Zod and matches the versioned snapshot                                                          | integration |
| R-RECOVERY-01    | State, approvals and budgets survive a restart; interrupted runs pause explicitly                                             | recovery    |
| R-RECOVERY-02    | A tampered audit log is detected after restart                                                                                | recovery    |
| R-E2E-02         | The whole lifecycle (questions, plan, approval, run, review, delivery, reopen) is drivable from the human CLI                 | e2e         |
| R-E2E-01         | A full flow completes with evidence and reopens with preserved context                                                        | e2e         |
| R-INTERP-01      | LLM interpretation of a report is advisory: it never changes the report, its hash or promotability                            | integration |
| R-INTERP-02      | Interpretation drops unknown paths, caps severity below HIGH and degrades to UNAVAILABLE on bad output                        | adversarial |
| R-INTERP-03      | Hostile commit text is data, and interpretation spends budget only through the AI runtime                                     | adversarial |
| R-ADAPTER-01     | The Ollama adapter works over a real HTTP connection and fails explicitly on errors                                           | integration |

| R-CONTRACT-02 | Only a human adds contract documents; a new version replaces the one consulted and the old one stays audited | adversarial |
| R-CONTRACT-03 | A project never sees another project contract, and documents with secrets are refused | adversarial |
| R-CONTRACT-04 | A triage verdict needs valid evidence from the stored documents; otherwise it is UNCLEAR and a human decides | adversarial |

Known gaps are tracked in [`docs/architecture/GENERATION-2.md`](architecture/GENERATION-2.md) under open decisions.
