# Para onde o JARVIS vai (programação)

Ideias para deixar o JARVIS ainda mais completo como parceiro de programação, em ordem de valor. Cada uma respeita a regra central: **a IA propõe, o código autoriza, o humano aprova o que é arriscado.**

## Já feito (método)

- Teste que reproduz o bug antes da correção, checagens obrigatórias por projeto (Node, Python, Java), critérios de aceite ligados a passos, commit local delegado em branch de trabalho.
- Autonomia delegada até risco MEDIUM (`jarvis autonomy`), com tudo HIGH e CRITICAL esperando o humano.
- Plano em Certeza / Proposta / Dúvida, diagnóstico obrigatório em bug, matriz de impacto opcional.
- Revisor cego consultivo, rascunhos de commit e PR, relatório de deriva da documentação.
- Plugin com `/jarvis:plan`, `/jarvis:dev`, `/jarvis:review`, `/jarvis:cycle`, `/jarvis:toc`.

## Próximos passos, por valor

| #   | Ideia                                                                                                                                                          | Por que importa                                                                                                               | Esforço |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------- |
| 1   | **Executor interno opcional**: um loop que implementa cada passo do plano em um worktree isolado, roda os testes e marca o passo, usando Ollama ou Claude Code | Hoje o JARVIS governa um agente externo. Com executor próprio ele "põe a mão na massa" sozinho, ainda sob as mesmas barreiras | Alto    |
| 2   | **Testes como portão com linha de base**: rodar a suíte antes e depois e barrar quando algo que passava passou a falhar                                        | Pega regressão, que é o erro mais caro                                                                                        | Médio   |
| 3   | **Checagens obrigatórias por projeto** (typecheck, lint, build) antes de commit, configuradas por você                                                         | Nada vai para o commit sem passar                                                                                             | Baixo   |
| 4   | **Detector de segredos no diff** antes do commit                                                                                                               | Evita vazar chave por engano                                                                                                  | Baixo   |
| 5   | **Mais linguagens**: detectar o executor de testes (npm, pytest, Maven, Gradle, dotnet)                                                                        | Hoje o foco é Node; seus projetos incluem Python e Java                                                                       | Médio   |
| 6   | **Integração com GitHub**: abrir o PR de verdade (com aprovação), ler issues como propostas, comentar a revisão cega no PR                                     | Fecha o ciclo sem sair do fluxo                                                                                               | Médio   |
| 7   | **ADR automático** a partir das decisões de um Work Item                                                                                                       | A memória do projeto vira documento                                                                                           | Baixo   |
| 8   | **Benchmark do método**: um conjunto fixo de tarefas que mede quanto o agente com o JARVIS acerta, com números                                                 | Prova de qualidade que serve de portfólio e de guia de evolução                                                               | Médio   |
| 9   | **Painel local** (terminal ou web) para o `digest`, as aprovações e os planos                                                                                  | Menos comandos, mais clareza                                                                                                  | Médio   |
| 10  | **Custo por Work Item e por passo**                                                                                                                            | Saber onde os tokens vão                                                                                                      | Baixo   |
| 11  | **Modo ausente com permissões permanentes e limitadas** (escopo, risco, prazo, orçamento; revogável)                                                           | É a sua ideia de continuar trabalhando quando você não consegue acompanhar. Depende de uma decisão de design                  | Alto    |
| 12  | **Monorepo e paralelismo**: vários Work Items em worktrees diferentes ao mesmo tempo                                                                           | Escala o trabalho                                                                                                             | Alto    |

## Decisões que ainda são suas

1. **Autonomia do executor interno (itens 1 e 11):** quanto o JARVIS pode fazer sozinho enquanto você está ausente? Minha sugestão: só risco baixo, dentro de um plano que você já aprovou, com testes passando e reversível.
2. **GitHub (item 6):** o JARVIS pode abrir PR em seu nome? Sugestão: só rascunho, e você publica.
3. **Prioridade:** para o seu objetivo (vaga de dev com IA aplicada), os itens 2, 3 e 8 são os que mais fortalecem o portfólio.
