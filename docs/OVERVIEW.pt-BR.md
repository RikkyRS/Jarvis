# JARVIS — visão geral (o que foi feito)

Documento em português para entender o projeto de ponta a ponta.  
Documentação técnica em inglês: `README.md` (PT), `docs/` (EN), `CONTRIBUTING.md`.

**Repo:** https://github.com/RikkyRS/Jarvis  
**Licença:** MIT  
**Versão atual:** 0.4.0

---

## 1. O que é

Harness **local** evidence-first para desenvolvimento assistido por IA.

| Papel | Quem |
|-------|------|
| Conversa e escreve código | Cursor / IDE / modelo |
| Governa Cycle, risco, evidência, memória | JARVIS (CLI + SQLite) |

Estado operacional: `.harness/` no projeto alvo (**gitignored**).  
Não é chatbot e não substitui o Cursor.

---

## 2. Arquitetura

```
Usuário / Cursor
      ↓
  jarvis CLI (intent PT + comandos EN)
      ↓
  Runtime (src/core/runtime.ts)
      ↓
  Cycle + Orchestrator + Lock + SQLite
      ↓
  Engines: Context, Impact, Risk, Security, Memory, Test, Git, Contract
      ↓
  Envelope autorizado → host implementa código
```

| Pasta | Função |
|-------|--------|
| `src/cli/` | CLI, aliases PT, resolução de projeto |
| `src/core/` | Runtime, Cycle, Orchestrator, recovery |
| `src/engines/` | Motores |
| `src/capabilities/` | Planning, development, review |
| `src/infrastructure/` | SQLite, harness, policy, memória global, HTTP local |
| `src/shared/` | Contratos, invariantes, comandos |
| `tests/` | unit, integration, recovery, fixtures |

---

## 3. Versões

### v0.2 — núcleo + MIT

- Licença MIT, migrations SQLite v1/v2
- Cycle: pause / resume / wait
- Context L2 estrutural (regex), Impact com L2
- Memory PROJECT (dedup) + GLOBAL (`~/.jarvis/`)
- Security com `npm audit`, testes impactados, risk acumulado

### v0.3 — publicação + tokens + backend local

- CI GitHub Actions, Dependabot, CONTRIBUTING / SECURITY / templates
- `brief` / `resumo` (economia de tokens), `memorize` / `memorizar`
- Cache `.harness/cache/agent-brief.json`
- `serve` — HTTP `127.0.0.1:39217` (estado continua local)
- Rules/skills Cursor: brief primeiro

### v0.4 — senior solo

- Policy `.jarvis.json` / `.jarvis.yml` (risco, git remote, requireTestBeforeClose)
- `logs` — timeline de events
- `reconcile` / `reconciliar` + `--remote` (fetch + REMOTE_ADVANCED)
- `wait --checks` via `gh` CLI
- Doctor: schema, gh, policy source

---

## 4. Comandos principais

| Comando | Função |
|---------|--------|
| `init` | Cria `.harness/` |
| `plan` / `planeje` | Abre Cycle |
| `dev` / `desenvolva` | Autoriza envelope |
| `test` / `teste` | Roda runner evidenciado |
| `review` / `revise` | Gaps vs contrato |
| `security` | Scan + audit |
| `brief` / `resumo` | JSON compacto |
| `memorize` / `memorizar` | Nota HOST |
| `logs` | Timeline |
| `reconcile` | Git local/remoto |
| `pause` / `resume` / `wait` | Gates |
| `close` / `feche` | Fecha Cycle |
| `serve` | Backend HTTP local |
| `doctor` | Saúde |

Flags: `--project`, `--approve`, `--deep`, `--remote`, `--checks`, `--commit`.

---

## 5. Fluxo típico

```text
jarvis resumo
jarvis planeje "objetivo"
jarvis desenvolva [--approve se HIGH]
# Cursor implementa
jarvis teste
jarvis revise
jarvis security
jarvis memorizar "decisão importante"
jarvis reconciliar --remote
jarvis feche
```

---

## 6. Onde ficam os dados

| Dado | Local |
|------|-------|
| Cycle, events, memory PROJECT | `.harness/state/jarvis.sqlite` |
| Brief cache | `.harness/cache/agent-brief.json` |
| Memória GLOBAL | `~/.jarvis/global/memory.jsonl` |
| Policy | `.jarvis.json` na raiz do projeto (versionável) |

---

## 7. Invariantes

- Evidence-first → sem evidência = UNKNOWN  
- HIGH → `--approve`  
- CRITICAL → bloqueado  
- Sem push / merge / PR automático  
- Uma sessão controla o Cycle aberto  
- Host implementa; JARVIS autoriza o envelope  

---

## 8. O que ainda falta (próximas fases)

Ver [ROADMAP.md](./ROADMAP.md) e [TEAM.v05.md](./TEAM.v05.md).

Resumo: Tree-sitter/L2 AST, impact com grafo, **estado compartilhado de equipe**, extensão IDE, publicação npm, matrix de testes pesada.

---

## 9. Instalação rápida

```powershell
git clone https://github.com/RikkyRS/Jarvis.git
cd Jarvis
npm install
npm run ci
npm run build
npm install -g .
jarvis doctor
```
