# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 0.3.x   | yes       |
| 0.2.x   | yes       |
| < 0.2   | no        |

## Reporting a vulnerability

**Do not open a public issue** for security vulnerabilities.

Send a private report via **GitHub Security Advisories** (recommended) or email the repository maintainer.

Include:

- Impact description
- Steps to reproduce
- JARVIS version (`jarvis doctor`)
- Whether it involves `.harness/`, git, or external command execution

## Scope

JARVIS runs locally and may invoke:

- `git` in the target project
- `npm test` / `pytest` / `rspec` when detected
- `npm audit` when `package.json` exists
- Optional localhost HTTP server (`jarvis serve`) bound to `127.0.0.1` by default

**CRITICAL** operations (force push, reset --hard, etc.) are blocked in objectives. **HIGH** requires explicit `--approve`.

## What we do not store

- Contents of `.env` or sensitive files (only filenames are evidenced)
- IDE or provider credentials
- Cycle state in the git repository (lives in `.harness/`, gitignored)

## Dependencies

Dependabot is configured in `.github/dependabot.yml`. Run `npm audit` on target projects via `jarvis security` when applicable.
