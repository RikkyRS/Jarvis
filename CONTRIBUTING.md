# Contributing

Thanks for your interest in JARVIS. This project is a **local harness** — state lives in `.harness/` on the target project (gitignored), not in the cloud.

## Quickstart (development)

```bash
git clone https://github.com/RikkyRS/Jarvis.git
cd jarvis
npm install
npm run ci      # typecheck + lint + test + build
npm run build
npm install -g .
jarvis doctor
```

## Local usage

```bash
cd /your/project
jarvis plan "your objective"    # or: jarvis planeje "…" (PT aliases)
jarvis dev
jarvis test
jarvis review
jarvis close
```

Inside the JARVIS runtime repository itself, use `--project` to point at the target.

## Token-efficient workflow (Cursor)

```bash
jarvis brief          # compact JSON — run first each turn
jarvis plan "…"       # only when opening a new Cycle
jarvis memorize "project convention or decision"
```

## Before opening a PR

1. Run `npm run ci` locally
2. Keep scope minimal — one logical change per PR
3. Do not commit `.harness/`, `node_modules/`, `dist/`, secrets, or `.env`
4. Update `README.md` (PT) or `docs/` (EN) if behavior changes
5. Add tests when fixing bugs or introducing new rules

## Architecture (where to edit)

| Folder | Responsibility |
|--------|----------------|
| `src/cli/` | CLI, PT intent aliases, target resolution |
| `src/core/` | Runtime, Cycle, Orchestrator, State |
| `src/engines/` | Context, Impact, Risk, Git, Test, Security, Memory |
| `src/capabilities/` | Planning, Development, Review (must not import tools/cli) |
| `src/infrastructure/` | SQLite, harness, migrations, global memory, local HTTP server |
| `tests/` | unit, integration, recovery |

Respect **import boundaries** (`tests/unit/boundaries.test.ts`).

## Out of scope (by design)

- Push, merge, force-push, or automatic PR
- Implementing the application feature (that is the host/IDE)
- Replacing the model or provider credentials
- Shared Cycle state for teams (v1 is single-user local)

## Releases

Semver tags: `v0.3.0`, …  
Update `CHANGELOG.md`, `src/shared/invariants.ts` (`JARVIS_VERSION`), and `package.json`.

## Questions

Open an issue with the appropriate template. For security, see [SECURITY.md](SECURITY.md).
