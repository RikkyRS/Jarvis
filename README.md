# JARVIS

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-green.svg)](https://nodejs.org/)
[![CI](https://img.shields.io/badge/CI-GitHub%20Actions-blue.svg)](.github/workflows/ci.yml)

Harness pessoal de desenvolvimento com **autonomia controlada**, **evidence-first** e **agnosticismo** de IDE, provider, modelo e stack.

> Documentação técnica em **inglês** em [`docs/`](docs/) e [`CONTRIBUTING.md`](CONTRIBUTING.md). Este README permanece em **português**.

O JARVIS é a **camada de runtime/controle**. O Cursor (ou outro host) continua sendo quem conversa com o modelo e implementa código — dentro do **envelope** que o JARVIS autoriza.

> **Local-first:** todo estado operacional fica em `.harness/` no seu projeto (gitignored). Publicar no GitHub não muda isso — você continua rodando `jarvis` na máquina.

```
Cursor / VS Code / Claude Code  →  invoca  →  jarvis CLI  →  Cycle + SQLite + engines
                                                      ↓
                                              .harness/ (estado local, gitignored)
```

### Quickstart (2 min)

```bash
git clone https://github.com/RikkyRS/Jarvis.git
cd jarvis
npm install && npm run ci && npm install -g .
jarvis doctor

cd /seu/projeto
jarvis planeje "implementar feature X"
jarvis desenvolva
jarvis feche
```

---

## O que o JARVIS faz (e o que não faz)

| Faz | Não faz |
|-----|---------|
| Cria e controla **Cycles** com evidência | Escrever a feature da aplicação sozinho |
| Mede **impacto**, **risco** e **permissão** | Push, merge ou PR automático |
| Protege **mudanças humanas** pré-existentes | Substituir o modelo ou a IDE |
| Roda **testes** quando há runner evidenciado | Inventar estado sem evidência |
| Autoriza **envelope de execução** para o host | Descartar/stash/reset git automaticamente |

---

## Requisitos

- **Node.js 20+** (testado em 24.x; usa `node:sqlite` nativo)
- **Git** (recomendado nos projetos alvo)
- **Cursor** (opcional, mas é o adapter principal documentado)

---

## Instalação no sistema

### Windows (PowerShell)

```powershell
cd C:\caminho\para\jarvis
npm install
npm test
npm run build
npm install -g .
jarvis doctor
```

Ou use o script:

```powershell
.\scripts\install.ps1
```

### Linux / macOS

```bash
cd /caminho/para/jarvis
npm install
npm test
npm run build
npm install -g .
jarvis doctor
```

### Verificar

```text
jarvis doctor
```

Resposta esperada: `"status": "OK"`.

Se `jarvis` não estiver no PATH:

```powershell
node C:\caminho\para\jarvis\dist\cli\index.js doctor
```

---

## Ativar no Cursor (qualquer projeto)

O JARVIS já está preparado para o Cursor via rules e skills em `~/.cursor/`:

| Arquivo | Função |
|---------|--------|
| `~/.cursor/rules/jarvis-runtime.mdc` | Manda o agente rodar o CLI antes de improvisar |
| `~/.cursor/rules/jarvis-commands.mdc` | Mapeia fala natural e `/jarvis:*` para CLI + skills |
| `~/.cursor/skills/jarvis-runtime/SKILL.md` | Como invocar no workspace aberto |
| `~/.cursor/skills/plan|dev|review|cycle/SKILL.md` | Personas depois do JSON do CLI |

### No chat do Cursor

Abra **qualquer projeto** e diga, por exemplo:

```text
jarvis planeje implementar paginação no modal
```

Ou use os atalhos:

```text
/jarvis:plan implementar paginação no modal
/jarvis:dev
/jarvis:review
/jarvis:cycle
```

O agente deve **executar o CLI de verdade**, ler o JSON (cycleId, risk, contract, envelope) e só então continuar a conversa.

### No terminal (qualquer pasta de projeto)

```powershell
cd C:\caminho\do\seu-projeto
jarvis planeje "implementar paginação no modal"
jarvis desenvolva
jarvis teste
jarvis revise
jarvis security
jarvis feche
```

O primeiro `planeje` **auto-inicializa** `.harness/` se o projeto ainda não tiver sido initado.

> **Exceção:** dentro do repositório do runtime (`package.json` com `"name": "jarvis"`), use `--project` para apontar o projeto alvo. O JARVIS recusa operar no próprio runtime sem isso.

---

## Comandos

### Forma canônica (inglês)

| Comando | Descrição |
|---------|-----------|
| `jarvis init` | Cria `.harness/`, SQLite e config no projeto |
| `jarvis status` | Estado do harness e Cycle ativo |
| `jarvis plan "<objetivo>"` | Abre Cycle: contexto, impacto, risco, contrato AC-* |
| `jarvis dev` | Autoriza envelope de execução (host implementa) |
| `jarvis test` | Detecta e roda pytest / npm test / rspec se existir |
| `jarvis review` | Revisa gaps evidenciados vs contrato |
| `jarvis security` | Scan de segurança (nomes sensíveis, objetivo destrutivo) |
| `jarvis context` | Descoberta estrutural L0/L1/L2 (`--deep` ou auto no `plan`) |
| `jarvis brief` / `jarvis resumo` | **JSON compacto** — leia isto antes de explorar o repo (economiza tokens) |
| `jarvis memorize "…"` / `memorizar` | Grava nota do host em memória PROJECT |
| `jarvis serve` | Backend **local** `127.0.0.1:39217` (opcional; estado continua em `.harness/`) |
| `jarvis logs` | Timeline de eventos (debug/audit) |
| `jarvis reconcile` | Reconcilia git local + fetch remoto opcional (`--remote`) |
| `jarvis pause` | Pausa o Cycle ativo |
| `jarvis wait --checks` | Lê checks de PR via `gh` CLI (quando disponível) |
| `jarvis resume` | Retoma Cycle pausado |
| `jarvis wait "<motivo>"` | Marca `WAITING_EXTERNAL` (PR/CI/gate manual) |
| `jarvis close` | Fecha Cycle, dedup memória PROJECT + promoção GLOBAL |
| `jarvis doctor` | Saúde do runtime (Node, identidade, fases) |

### Linguagem natural (português)

O CLI entende verbos em PT — o token `jarvis` no meio da frase é ignorado:

| Você fala | Vira |
|-----------|------|
| `planeje`, `planejar`, `planeja` | `plan` |
| `desenvolva`, `implemente`, `implementar` | `dev` |
| `teste`, `testar`, `testes` | `test` |
| `revise`, `revisar`, `revisão` | `review` |
| `segurança`, `seguranca` | `security` |
| `contexto` | `context` |
| `feche`, `fechar`, `encerrar` | `close` |
| `inicialize`, `inicie` | `init` |
| `estado` | `status` |
| `diagnóstico` | `doctor` |
| `pausar`, `pausa` | `pause` |
| `retomar`, `continuar` | `resume` |
| `aguardar`, `aguarde`, `esperar` | `wait` |

Exemplos:

```text
jarvis planeje implementar autenticação JWT
jarvis desenvolva --approve
jarvis teste
jarvis revise
jarvis feche
```

---

## Flags

| Flag | Uso |
|------|-----|
| `--project <path>` | Projeto alvo (obrigatório dentro do repo do runtime) |
| `--approve` | Aprovação explícita para operações **HIGH** |
| `--commit` | No `close`, tenta commit local (nunca push) |
| `--deep` | Context L2 estrutural (sem AST) |
| `--session <id>` | Sessão para lock de Cycle |
| `--json` | Saída JSON (padrão já é JSON) |
| `-h`, `--help` | Ajuda |

---

## Fluxo de um Cycle

```text
planeje "objetivo"
    → PLANNING / READY (ou BLOCKED se CRITICAL)
desenvolva [--approve se HIGH]
    → EXECUTION_AUTHORIZED + envelope
    → host (Cursor) implementa dentro do envelope
teste
    → pytest / npm test / rspec (se evidenciado)
revise
    → gaps vs contrato (AC-*)
security
    → re-scan + npm audit + risk acumulado
pausar / retomar / aguardar
    → PAUSED / WAITING_EXTERNAL para gates externos
feche [--commit --approve]
    → COMPLETED / ABANDONED; memória PROJECT dedup + promoção GLOBAL
```

Saída típica do `plan`: `cycleId`, `context`, `impact`, `risk`, `security`, `contract`, `git_baseline`.

Saída típica do `dev`: `EXECUTION_AUTHORIZED` ou `REQUIRES_APPROVAL` ou `BLOCKED`.

---

## Segurança e invariantes

- **Evidence-first:** sem evidência → `UNKNOWN`, nunca afirmar como fato
- **HIGH** → exige `--approve`
- **CRITICAL** (ex.: force push, reset --hard) → **bloqueado** mesmo com `--approve`
- **3 retries** por operação lógica + detecção de **loop** (3 fingerprints iguais)
- **Uma sessão** controla o Cycle aberto (outra sessão → `CONFLICT`)
- **Mudança humana** entra na camada `HUMAN` e vira `protectedHumanPaths`
- **Orchestrator** dono do fluxo; Capability/Tool não governam o Cycle
- **Sem push / merge / PR** automático

Detalhes das fases: [`docs/architecture/phases.md`](docs/architecture/phases.md).

---

## Estrutura do projeto

```text
jarvis/
├── src/
│   ├── cli/              # Interface de linha de comando
│   ├── core/             # Orchestrator, Cycle, State, Runtime
│   ├── engines/          # Context, Impact, Risk, Git, Test, Security…
│   ├── capabilities/     # Planning, Development, Review…
│   ├── tools/            # Registry + Permission por tool
│   ├── adapters/         # Linguagens (TS/Python/Ruby) + IDE
│   ├── infrastructure/   # SQLite, harness, session
│   └── shared/           # Contratos Zod, invariantes, policy
├── tests/                # unit, integration, recovery, fixtures
└── docs/architecture/    # Fases, boundaries, review
```

Estado local por projeto (gitignored):

```text
.harness/
├── config.json
├── state/jarvis.sqlite
├── cycles/
├── memory/
├── context/
├── cache/
├── locks/
└── logs/
```

---

## Desenvolvimento do runtime

```bash
npm install
npm run ci        # typecheck + lint + test + build (mesmo gate do GitHub Actions)
npm run jarvis -- doctor
```

---

## Alinhamento com o plano de implementação

| Área do plano | Status |
|---------------|--------|
| Fases 0–21 (bootstrap → E2E) | Implementadas |
| Fase 22 (revisão final escrita) | `docs/architecture/review.md` — sign-off v0.2 |
| Identity / agnosticismo | Sim |
| Cycle + lock + SQLite + event log | Sim |
| Evidence-first + Risk + Permission | Sim |
| Contract / AC-* | Sim |
| Context L0/L1 | Sim |
| Context L2 (AST / Tree-sitter) | Parcial (`--deep` estrutural) |
| Adapters IDE (extensão) | Rules/skills Cursor; sem extensão VS Code |
| Host implementa código | Por design |

---

## Policy por projeto (`.jarvis.json`)

Copie [`docs/examples/jarvis.policy.example.json`](docs/examples/jarvis.policy.example.json) para a raiz do projeto alvo.

```json
{
  "risk": { "requireApprovalFrom": "HIGH", "blockCritical": true },
  "git": { "remote": "origin", "fetchOnReconcile": true },
  "workflow": { "requireTestBeforeClose": false }
}
```

---

## Memória e tokens (Cursor)

O agente gasta tokens quando re-explora o repo a cada turno. Fluxo recomendado:

```text
jarvis resumo          # brief compacto: cycle, risk, memory bullets, next step
jarvis planeje "…"     # só ao abrir cycle (JSON maior)
jarvis desenvolva
jarvis memorizar "pnpm + vitest; não usar jest"
jarvis feche
```

Cache em `.harness/cache/agent-brief.json` (gitignored). Memória global em `~/.jarvis/global/memory.jsonl`.

Backend opcional (local-only):

```bash
jarvis serve
curl "http://127.0.0.1:39217/brief?project=C:/seu/projeto"
```

---

## Limitações honestas (v0.4.0)

- Licença **MIT** — uso livre; sem garantias
- Não substitui o modelo: **você/Cursor** codam dentro do envelope
- L2 usa regex estrutural, não Tree-sitter/AST completo
- `npm audit` só roda em projetos com `package.json`
- Testes impactados dependem de convenção de nomes (`*.test.ts`, `test_*.py`, etc.)
- Commit no `close` é local; push continua manual

---

## Documentação extra

> Arquivos abaixo em **inglês**, exceto este README e a visão geral em PT.

- [Visão geral (PT)](docs/OVERVIEW.pt-BR.md) — o que foi feito, de ponta a ponta
- [Team v0.5 plan](docs/TEAM.v05.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)
- [Changelog](CHANGELOG.md)
- [Roadmap](docs/ROADMAP.md)
- [Installation](docs/INSTALLATION.md)
- [Integration / Cursor](docs/INTEGRATION.md)
- [Architecture phases](docs/architecture/phases.md)
- [Final review](docs/architecture/review.md)
- [Boundaries](docs/architecture/boundaries.md)

### Publicar no GitHub

Repositório: [github.com/RikkyRS/Jarvis](https://github.com/RikkyRS/Jarvis)

```powershell
git remote add origin https://github.com/RikkyRS/Jarvis.git
git push -u origin main
git tag v0.4.0
git push origin v0.4.0
```

---

## Licença

[MIT](LICENSE) — Copyright (c) 2026 JARVIS
