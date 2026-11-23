# Changelog

## 1.0.0-alpha.0 — Generation 2 foundation

Clean redesign; Generation 1 (0.6.x) removed and preserved at tag `legacy-0.6.0-gen1`.

- Zod domain contracts, workflow/work-item state machines.
- Deterministic policy engine (config can only tighten).
- Operation-specific, single-use, human-only approvals bound to a fingerprint.
- Append-only, hash-chained audit log.
- Execution Gateway: path canonicalization, replay protection, approval consumption, isolation enforcement, evidence required for success.
