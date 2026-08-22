# Boundaries

Rules enforced in `tests/unit/boundaries.test.ts`:

- `adapters` must not import `core`, `engines`, `capabilities`, `tools`, or `cli`
- `capabilities` must not import `tools` or `cli`
- `engines` must not import `capabilities` or `cli`
- `cli` must not import `engines`, `capabilities`, or `tools`

The Orchestrator (`src/core/orchestrator`) is the only place allowed to coordinate engines and capabilities. Capabilities must not call privileged tools directly — they go through Permission / Tool Registry.
