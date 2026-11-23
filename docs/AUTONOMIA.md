# Autonomia delegada

Você decide **uma vez** quanto o JARVIS pode fazer sem perguntar, e entra só nos assuntos críticos. A decisão fica gravada, auditada, e o JARVIS nunca passa dela.

## Os dois níveis

| Nível                 | O que acontece                                                                                     |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| `SUPERVISED` (padrão) | Todo plano e todo início de execução esperam a sua aprovação                                       |
| `INTERMEDIATE`        | Um plano cujas operações são todas de risco **LOW ou MEDIUM** é aprovado e iniciado pela delegação |

Risco de cada operação:

| Risco    | Operações                                                     | No INTERMEDIATE                       |
| -------- | ------------------------------------------------------------- | ------------------------------------- |
| LOW      | ler arquivo, inspecionar o git                                | sozinho                               |
| MEDIUM   | editar arquivo, rodar teste, preparar (stage), criar worktree | **sozinho**                           |
| HIGH     | **commit, push, merge**, remover worktree                     | **espera você, uma operação por vez** |
| CRITICAL | force push, reset duro, clean                                 | **bloqueado**                         |

Na prática: ele planeja, implementa e testa sozinho dentro de um worktree isolado. Para **gravar** o resultado (commit) ou **publicar** (push, merge), ele pede a sua aprovação lendo os parâmetros exatos.

## Como ligar

```bash
jarvis autonomy set INTERMEDIATE                      # ligar
jarvis autonomy set INTERMEDIATE --max-estimate 60000 # planos acima de 60 mil tokens continuam esperando você
jarvis autonomy set INTERMEDIATE --auto-confirm-in-scope  # pedidos de cliente dentro do contrato viram tarefa sozinhos
jarvis autonomy set SUPERVISED                        # desligar
```

Só você muda isso, pela CLI. O arquivo `.jarvis/config.json` é protegido: um agente não consegue escrevê-lo, então ele não pode se dar mais autonomia. Se você editar o arquivo à mão, a mudança vale, mas não gera o evento de auditoria: prefira a CLI.

## Como usar

```bash
jarvis autonomy status --mission <id>   # o que rodaria sozinho agora, e por que não, quando não roda
jarvis autonomy tick --mission <id>     # uma rodada: aprova e inicia o que está elegível
```

Você pode rodar o `tick` quando quiser, ou agendá-lo na sua máquina (Agendador de Tarefas do Windows ou cron) para ele seguir trabalhando quando você não estiver acompanhando. Em cada rodada o JARVIS aprova o que é elegível, inicia o que está esperando e **lista o que ficou para você, com o motivo**.

## O que NUNCA roda sozinho

Um plano não é aprovado pela delegação se:

- tem qualquer operação HIGH ou CRITICAL;
- o projeto exige aprovação para algum tipo de operação que ele usa;
- toca os arquivos de controle (`.jarvis/`);
- a estimativa passa do limite que você definiu ou do orçamento de execução autorizado;
- ainda tem dúvida aberta, pergunta importante sem resposta, bug sem diagnóstico ou linha da matriz sem decisão (as mesmas regras de qualquer aprovação).

Sobre pedidos de cliente (`--auto-confirm-in-scope`), só entra sozinho o pedido que a triagem marcou **dentro do contrato, citando a cláusula, e que não é duplicado**. Fora do contrato (dinheiro), duvidoso ou repetido: sempre espera você.

## Como fica registrado

Cada decisão automática aparece na auditoria como ator `autonomy` (nunca como você), com a impressão digital da configuração que a permitiu: `planning.plan_auto_approved`, `workflow_run.auto_started`, `intake.proposal_auto_confirmed`. A mudança do nível aparece como `config.autonomy_changed`, com o seu nome. Assim dá para provar, depois, que cada ação automática vinha de uma escolha sua.

## O que ela não muda

Todas as outras barreiras seguem valendo: política de risco, isolamento do código não confiável, caminhos protegidos, orçamento de tokens, plano que prende cada passo a operações reais, e a auditoria com hash. A autonomia só remove a pergunta onde o risco é baixo ou médio.

## Commit local sem pedir (opcional)

```bash
jarvis autonomy set INTERMEDIATE --allow-local-commit
```

Com isso, um **commit local** passa pela delegação, e só se todas estas condições valerem:

- o plano aprovado tem um passo de commit (e um rollback);
- o commit é numa **branch de trabalho**: nunca em `main`, `master`, `develop`, `production`, `release/*`, `hotfix/*` nem na branch padrão do remoto;
- as **checagens obrigatórias** do projeto passaram desde a última mudança;
- o diff em stage é exatamente o que o commit leva (o handler confere o hash).

**Push e merge continuam sempre com você.** Na auditoria o commit aparece como `execution.delegated`, ator `autonomy`, com a branch.

## Para você decidir depois

- **Rodada automática agendada** pelo próprio JARVIS, em vez de você agendar o `tick`.
