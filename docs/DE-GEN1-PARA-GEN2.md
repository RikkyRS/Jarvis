# JARVIS: da Geração 1 para a Geração 2 (guia para explicar)

Este arquivo existe para você **explicar o projeto com segurança** em entrevista ou conversa técnica: o que mudou, como ficou e por que cada decisão foi tomada. Tudo aqui foi conferido no código, nos testes e nos documentos em `docs/architecture/`. Onde algo é interpretação minha, está marcado como **(interpretação)**.

Fontes: `docs/architecture/GENERATION-2.md` (decisões), `docs/architecture/THREAT-MODEL.md` (ameaças), `CHANGELOG.md`, tag `legacy-0.6.0-gen1` (versão antiga).

---

## 1. A explicação em 30 segundos

> O JARVIS é uma camada de controle entre uma pessoa, uma IA e o código. A IA pode raciocinar, planejar e **pedir** ações, mas não pode se autorizar. Quem decide e executa é código determinístico: uma política de risco, aprovações humanas de uso único e um gateway por onde passa todo efeito colateral, com auditoria que detecta adulteração.

Frase curta para guardar: **"a IA propõe, o código autoriza, o humano aprova o que é arriscado."**

---

## 2. O que trocou

|                      | Geração 1 (v0.6.0, tag `legacy-0.6.0-gen1`)                                               | Geração 2 (1.0.0-alpha)                                                                                                                          |
| -------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ideia central        | Harness local com **Cycles** (planejar, desenvolver, testar, revisar, fechar) e evidência | **Runtime determinístico**: contratos, política, aprovação, gateway e auditoria                                                                  |
| Quem manda           | O Cursor/host conversa com o modelo dentro de um "envelope" que o JARVIS autoriza         | Qualquer cliente de IA (Claude Code, Cursor, VS Code, agentes locais) usa os **mesmos contratos**                                                |
| Entrada              | CLI + intenção em linguagem natural                                                       | **CLI** (humano) + **MCP** (IA) + intake por WhatsApp (vira proposta)                                                                            |
| Risco                | Gates de risco (LOW, MEDIUM, HIGH, CRITICAL) por heurística no Cycle                      | Política **determinística e validada por schema**; config do projeto só pode **apertar**, nunca afrouxar                                         |
| Aprovação            | Flag `--approve`                                                                          | Aprovação **ligada a uma operação**, com impressão digital dos parâmetros, expiração e **uso único**; só um principal `human` decide             |
| Auditoria            | Logs                                                                                      | Trilha **append-only** (triggers no banco) com **hash encadeado**, verificável (`audit verify`)                                                  |
| Efeitos colaterais   | Vários caminhos                                                                           | **Um único Execution Gateway**                                                                                                                   |
| Código de terceiros  | Rodava no host quando havia runner                                                        | Código não confiável só roda em **container** (sem rede, raiz somente leitura, sem variáveis de ambiente); sem container, o gateway **bloqueia** |
| Trabalho em paralelo | Um Cycle ativo por vez                                                                    | Projetos, Missions, Work Items e Workflow Runs, cada Run em **git worktree isolado**                                                             |
| Integração           | Não existia                                                                               | **Integration Resolver**: avalia o branch candidato inteiro antes de promover ao `main`                                                          |
| Custo de IA          | Não existia                                                                               | **Orçamento de tokens por Mission** (preparação e execução separadas), reserva atômica                                                           |
| Linguagem/contratos  | TypeScript                                                                                | TypeScript com **Zod** como fonte da verdade e **JSON Schema** exportado                                                                         |
| Estado               | `.harness/`                                                                               | SQLite com migrations, checkpoints e recuperação explícita                                                                                       |
| Testes               | 57                                                                                        | **147 passando, 3 ignorados (opt-in)** (verificação opt-in com Docker real)                                                                      |
| Compatibilidade      | n/a                                                                                       | **Nenhuma** com a Gen 1, por decisão (redesenho limpo)                                                                                           |

Tamanho: a Gen 1 tinha cerca de 61 arquivos em `src/`; a Gen 2 tem cerca de 7,5 mil linhas de TypeScript em `src/`, divididas em módulos por responsabilidade.

---

## 3. Por que trocar (as razões)

Estas razões vêm do documento de arquitetura, não de achismo:

1. **A IA não pode ser prova de nada.** Invariante 2: saída de LLM, texto de prompt, argumentos de ferramenta e flags do cliente nunca contam como aprovação. Na Gen 1, um `--approve` passado na linha de comando era a barreira. Na Gen 2, a aprovação é um registro no banco, ligado a uma operação específica, que um agente não consegue criar.
2. **"Permissão consultiva" não é sandbox.** O documento diz isso literalmente. Um envelope que a IA pode ignorar não protege. Por isso tudo passa por um gateway que executa de verdade a política.
3. **Todos os efeitos colaterais por um só lugar.** Fica um ponto para auditar, testar e proteger, em vez de vários caminhos que podem divergir.
4. **O estado precisa sobreviver.** Workflows, aprovações e evidências são dados duráveis, não histórico de chat. Se o processo cair, o trabalho vai para `PAUSED` de forma explícita.
5. **Quem implementa não valida a si mesmo.** Invariante 11: o agente que escreveu a mudança não é o juiz final da integração. Daí o Integration Resolver independente.
6. **Escalar para vários agentes e várias tarefas.** Um Cycle por vez não comporta trabalho paralelo, por isso Work Items e worktrees.
7. **Redesenho limpo.** O projeto era uma ferramenta pessoal em evolução. Manter compatibilidade com a Gen 1 travaria as decisões novas, então o documento autoriza descartar o legado. **(interpretação)** O custo é perder quem usa a v0.6, que é aceitável porque o projeto é pessoal e o histórico fica na tag.

---

## 4. Como funciona (o caminho de uma operação)

```
Humano ── CLI ──┐
                ├── API tipada ── Workflow ── Política de risco
IA ──── MCP ───┘                                  │
                                         Aprovação (se HIGH)
                                                  │
                                         Execution Gateway
                          (valida, canonicaliza caminho, consome aprovação,
                           checa isolamento, executa, guarda evidência)
                                                  │
                                       Auditoria (hash encadeado)
```

Exemplo real de uso com uma operação de risco (commit, push, merge):

1. O agente chama `jarvis_request_operation` e recebe `APPROVAL_REQUIRED` com um `approvalId`.
2. Você roda `jarvis approvals` e `jarvis approve <id>` e **lê exatamente o que está aprovando**.
3. O agente chama `jarvis_resume_operation`. O gateway **reverifica tudo** e executa **uma única vez**.

Níveis de risco: LOW e MEDIUM liberam, HIGH exige aprovação humana, CRITICAL fica bloqueado (por exemplo `force push` e `reset`/`clean` destrutivo). Commit e push exigem **aprovações separadas**.

Por que a aprovação é presa à operação: se o alvo, o diff, o branch, o remoto ou o comando mudarem, a aprovação deixa de valer. Isso impede reutilizar um "sim" para outra coisa.

### Módulos principais (`src/`)

| Pasta                                   | Responsabilidade                                                            |
| --------------------------------------- | --------------------------------------------------------------------------- |
| `domain/`                               | Contratos (Zod), IDs e máquina de estados do workflow                       |
| `policy/`                               | Política de risco (a config só aperta)                                      |
| `approval/`                             | Aprovações de uso único, só humano decide                                   |
| `gateway/`                              | Único caminho para efeitos colaterais; caminhos, runner, container          |
| `persistence/`                          | SQLite, migrations, auditoria append-only com hash                          |
| `budget/`                               | Orçamento de tokens por Mission                                             |
| `git/`                                  | Handlers de git e worktrees                                                 |
| `integration/`                          | Integration Resolver                                                        |
| `knowledge/`                            | Conhecimento do projeto, com rejeição de segredos                           |
| `ai/`, `runtime/`                       | Provedores (Ollama, Claude Code), roteador, scheduler, proteção contra loop |
| `mcp/`, `cli/`                          | Adaptadores de entrada                                                      |
| `intake/`                               | Mensagens (WhatsApp) viram **proposta** que um humano confirma              |
| `planning/`, `requirements/`, `report/` | Plano, análise de requisitos e relatório de mudança                         |

---

## 5. Decisões confirmadas e o porquê de cada uma

| Decisão                                                                  | Razão                                                                                               |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Zod por dentro, JSON Schema por fora                                     | Uma só fonte da verdade para validar e para quem integra de fora                                    |
| SQLite com interfaces de persistência                                    | Simples e local agora, portável a PostgreSQL depois                                                 |
| Worktree por Workflow Run, branch de referência por Work Item            | Execuções paralelas sem pisar no diretório umas das outras; fechar um worktree não fecha o trabalho |
| Isolamento híbrido (restrições locais + container)                       | Container reduz risco, mas não prova segurança; por isso a decisão é por nível de confiança         |
| Autorização dupla para grants de admin                                   | Ninguém edita a própria permissão                                                                   |
| Associação híbrida de PRs e contribuições                                | Não adivinha com sinais fracos (há teste para isso)                                                 |
| Auditoria: eventos críticos permanentes, dados operacionais com retenção | Auditar sem crescer para sempre                                                                     |
| Revisão técnica em camadas, proporcional ao risco                        | Gasta o esforço onde o risco está                                                                   |
| Orçamento de tokens, sem custo financeiro                                | Decisão registrada: só contagem de tokens                                                           |
| LangChain/LangGraph **opcionais**                                        | O núcleo determinístico não depende de framework de IA                                              |

---

## 6. Segurança: as ameaças e o que cobre cada uma

O `THREAT-MODEL.md` lista 17 ameaças, cada uma com controle e teste que a comprova (os códigos `R-...`). Para entrevista, estas seis contam bem a história:

| Ameaça                                                       | Controle                                                                               |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Agente aprova a própria operação                             | Só principal `human` decide; o MCP não tem ferramenta de aprovar                       |
| Aprovação reaproveitada                                      | Uso único e fingerprint da operação; o commit refaz o hash do diff                     |
| Prompt injection em arquivo do repo ou mensagem              | Conteúdo é dado; a saída do classificador só gera **proposta**, que um humano confirma |
| Escape de caminho (`../`, symlink)                           | Canonicalização contra a raiz real do projeto                                          |
| Adulteração do log de auditoria                              | Triggers append-only + hash encadeado, verificado sob demanda                          |
| Agente reescreve `.jarvis/config.json` para se dar confiança | O gateway nega edição e stage em `.jarvis/`                                            |

**Limites honestos (o documento também diz):** container reduz risco, não garante; o usuário do sistema operacional pode editar o SQLite (o hash **detecta**, não impede); a aprovação mostra parâmetros, não revisa semanticamente o que um script faz; e a qualidade do modelo está fora da garantia. Falar dos limites sem ser perguntado passa maturidade.

---

## 7. Os testes (147 passando, 3 ignorados opt-in)

| Área                                                | Arquivos                         |                               Testes |
| --------------------------------------------------- | -------------------------------- | -----------------------------------: |
| Gateway (política, caminhos, aprovação, isolamento) | `integration/gateway`            |                                   18 |
| Runtime de IA (roteador, scheduler, loops)          | `integration/ai-runtime`         |                                   15 |
| Domínio e orçamento de tokens                       | `integration/domain-budget`      |                                   13 |
| Notas e planejamento                                | `integration/planning-notes`     |                                   12 |
| Integration Resolver e conhecimento                 | `integration/resolver-knowledge` |                                   12 |
| Intake (WhatsApp, HMAC)                             | `integration/intake`             |                                   11 |
| Git e worktrees                                     | `integration/git`                |                                   10 |
| Fluxo ponta a ponta                                 | `e2e/full-flow`                  |                                   10 |
| Adaptadores (CLI e MCP)                             | `integration/adapters`           |                                    8 |
| Domínio (unitário)                                  | `unit/domain`                    |                                    7 |
| Passos do plano                                     | `integration/plan-steps`         |                                    6 |
| Recuperação após falha                              | `recovery`                       |                                    6 |
| Requisitos                                          | `unit/requirements`              |                                    5 |
| Rastreabilidade                                     | `unit/traceability`              |                                    3 |
| Caminhos protegidos                                 | `e2e/protected-paths`            |                                    2 |
| Ciclo de vida da CLI                                | `e2e/cli-lifecycle`              |                                    1 |
| Isolamento com Docker real                          | `integration/docker-live`        |           1 (opt-in, ignorado no CI) |
| Interpretação do Resolver por LLM                   | `integration/interpretation`     |                                    6 |
| Adaptador Ollama sobre HTTP real                    | `integration/providers-http`     |                                    2 |
| Ollama e Claude Code reais (opt-in)                 | `integration/providers-live`     |                  2 (ignorados no CI) |
| **Total**                                           |                                  | **150** (147 passando + 3 ignorados) |

O que isso mostra: os testes cobrem as **regras de segurança** (R-APPROVAL, R-PATH, R-AUDIT, R-ISO, R-BUDGET, R-INTEGRATION...), não só o caminho feliz. Eles rodam com `npm test`, e `npm run ci` faz typecheck, lint, testes e build.

---

## 8. Perguntas que podem fazer, com respostas

**Por que reescrever em vez de evoluir a Gen 1?**
A Gen 1 confiava num envelope consultivo e numa flag de aprovação. Para a IA não conseguir se autorizar, a arquitetura precisava mudar (gateway único, aprovação persistida e presa à operação). Isso quebrava contratos e o banco, então um redesenho limpo era mais honesto do que remendar. A versão antiga continua na tag `legacy-0.6.0-gen1`.

**Como você garante que a IA não aprova a própria ação?**
Aprovar só existe no canal da CLI, para um principal `human`. O MCP, que é o canal da IA, não expõe ferramenta de aprovar. E o campo de confiança que a requisição traz é sobrescrito pela configuração, que só o humano edita.

**O que impede reaproveitar uma aprovação?**
Ela é de uso único e presa ao ID da operação, ao projeto, ao workflow, ao alvo canônico e ao fingerprint dos parâmetros. Mudou qualquer coisa relevante, vale zero. No commit, o diff em stage é recalculado.

**Por que o hash encadeado na auditoria?**
Para detectar adulteração. Quem tem acesso ao arquivo SQLite pode editar, e eu não consigo impedir isso. O hash faz a edição ser **detectada** em `audit verify`. Assumo esse limite no threat model.

**Por que worktrees?**
Para duas execuções não mexerem no mesmo diretório. Worktree isola o diretório, mas não prova que as mudanças são compatíveis entre si. Por isso existe o Integration Resolver, que avalia o conjunto antes do `main`.

**Por que LangGraph/LangChain são opcionais aqui?**
O núcleo precisa ser determinístico e testável sem modelo. O framework pode entrar na camada de inteligência (resumir, propor plano), mas nunca decide permissão.

**Algo que ainda falta?**
Testes de container com daemon real no CI, interpretação do Resolver assistida por LLM, estimativa automática de orçamento. Está na seção "Next" do README. É alpha, e eu digo isso.

---

## 9. Como rodar e mostrar

```bash
npm install
npm run ci                                   # typecheck, lint, testes, build
node dist/cli/main.js status
node dist/cli/main.js audit verify           # prova a cadeia de hash
node dist/cli/main.js approvals              # o que espera aprovação
```

Conectar a um cliente de IA (Claude Code):

```bash
claude mcp add jarvis -- node C:/caminho/Jarvis/dist/cli/main.js mcp --client claude
```

Demonstração curta que funciona bem: pedir ao agente uma operação HIGH, mostrar o `APPROVAL_REQUIRED`, aprovar na CLI lendo os parâmetros e deixar o agente retomar.

---

## 10. O que dizer e o que evitar

- Diga: **"alpha"**, "147 testes", "runtime determinístico", "a IA propõe, o código autoriza".
- Não diga: "usado em produção", número de usuários ou "à prova de falhas". Nada disso é verdade, e o próprio threat model lista os limites.
- Mostre o raciocínio (invariantes, ameaças, limites) mais do que a lista de funcionalidades.

---

## 11. O que foi fechado depois e o que ainda falta

**Fechado na branch `chore/pos-gen2-melhorias`**

- Isolamento Docker agora roda contra um **daemon real no CI** (job `docker-isolation`, que falha se o teste for ignorado).
- Adaptador Ollama testado sobre **HTTP real**; testes opt-in com **Ollama e Claude Code de verdade** (ambos passaram). No caminho apareceu um limite real: no Windows o adaptador do Claude Code precisa do `claude.exe` nativo, porque um atalho `.cmd` não inicia sem shell. A mensagem de erro agora diz isso.
- **Interpretação do Resolver por LLM** (`src/integration/interpret.ts`): consultiva. Descarta caminhos que não estão no relatório, nunca passa de MEDIUM, vira UNAVAILABLE se o modelo errar, e **não participa** da decisão de promover.
- README, guia de testes gerado dos testes reais e demo da CLI.

**Ainda em aberto (decisões de design)**

- Perfis de container além do padrão travado; proveniência de imagem além do digest fixado.
- Delegação de permissões e semântica de revogação quando o acesso à Mission muda.
- Regras de concorrência e prioridade além de "prioridade, depois ordem de chegada".
- Convenções de metadados de PR além de IDs explícitos `wi_…`.
- Se o JARVIS pode resolver sozinho tarefas simples de baixo risco (hoje só **propõe**).
- Formato de arquivamento da auditoria além do hash no próprio lugar.

**Limites de projeto (decididos, não bugs)**

- Uso local, um processo e um operador humano. Rede compartilhada fica fora do escopo até existirem identidade e gestão de segredos.
- Sem contabilidade financeira, só contagem de tokens.

---

## 12. Contrato por projeto e triagem de pedidos

A ideia central do JARVIS: ele faz o trabalho, tira as dúvidas com você e continua útil quando você não consegue acompanhar tudo. O contrato é **do projeto**, não do JARVIS.

- **Onde vive:** na base do projeto (isolada por projeto). Só um humano adiciona (`jarvis contract add CONTRACT|SCOPE|HISTORY arquivo`, aceita `.md`, `.txt` e `.pdf`). O agente só lê, pelo MCP (`jarvis_project_contract`).
- **Versões:** uma versão nova substitui a consultada; a antiga fica guardada e auditada, mas não é consultada. Assim ele não relê tudo a cada pedido.
- **Consulta seletiva:** o contrato é dividido em cláusulas e a busca devolve só as poucas que importam, com documento, versão e cláusula.
- **Triagem:** `REPEATED`, `IN_SCOPE`, `OUT_OF_SCOPE` ou `UNCLEAR`, sempre citando a evidência. Sem evidência válida vira `UNCLEAR` e um humano decide. Sem nada relevante no contrato, o modelo nem é chamado (sem gastar tokens).
- **Quem decide:** a triagem é consultiva. O que está dentro do contrato vira proposta e plano; **você aprova o plano e só então ele executa**. O que está fora vira aviso de escopo.
- **Projeto sem contrato:** funciona normalmente. A triagem vira `UNCLEAR` com o motivo `NoContractOnFile`, o modelo nem é chamado e o pedido segue direto para proposta, plano e aprovação. Só com histórico (sem contrato), repetições ainda são detectadas, mas o escopo nunca é adivinhado.

---

## 13. O fluxo ponta a ponta e a privacidade

- **Fluxo:** mensagem do cliente (`inbox add` ou webhook) → `inbox process` classifica em propostas e confere cada uma contra o contrato do projeto → `digest` mostra o que espera por você → você confirma a proposta, aprova o plano e só então ele executa. O JARVIS pode **rascunhar** a resposta ao cliente, mas **não tem como enviar**.
- **Teste real:** com o Ollama local (`qwen2.5:7b`) e um contrato de exemplo, "dois clientes no mesmo horário de novo" foi marcado `REPEATED` citando o histórico de 02/10, e "queremos um aplicativo móvel nativo" foi marcado `OUT_OF_SCOPE` citando a Cláusula 3. Levou cerca de 2,5 minutos em CPU para duas mensagens.
- **Privacidade:** `docs/PRIVACIDADE.md` mostra o caminho do dado, o que o JARVIS garante e o que ele não controla (Meta, túnel, o seu computador). `jarvis privacy` confere o estado atual.

---

## 14. O método de engenharia

Inspirado no _personal harness_ de Gabriel Tupi (com a permissão dele, reescrito de forma genérica). Ele cuida de **como pensar**; o JARVIS cuida de **o que pode acontecer**.

| Ideia                       | Como virou código                                                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Certeza / Proposta / Dúvida | `certainties` (com evidência), `proposals`, `doubts`. Dúvida sem resolução bloqueia a aprovação do plano (`OPEN_DOUBTS`)            |
| Bug: causa antes de editar  | `kind: BUGFIX` exige `diagnosis`; sem ela o plano não é aprovável (`NO_DIAGNOSIS`), e sem plano aprovado nada executa               |
| Matriz de impacto           | `impactMatrix` opcional; linha sem decisão bloqueia (`MATRIX_ROW_WITHOUT_DECISION`)                                                 |
| Revisor cego                | `jarvis review blind`: só plano, critérios e código; veredito calculado pelos achados; achado com referência inventada é descartado |
| Auxiliar de ciclo           | `jarvis cycle commit                                                                                                                | pr`: rascunhos a partir do plano aprovado |
| `toc`                       | `jarvis docs-drift`: o que ainda vale, o que envelheceu e o que não dá para verificar                                               |
| Comandos `/plan`, `/dev`... | Plugin em `plugin/`, testado contra as ferramentas e comandos reais                                                                 |

**Como explicar a diferença:** "o método dele é o que o agente _deveria_ fazer; o JARVIS é o que o agente _não consegue deixar de_ fazer". Quem dá o formato é o plano; quem impede o desvio é o runtime.

Mais ideias em [`docs/ROADMAP.md`](ROADMAP.md).
