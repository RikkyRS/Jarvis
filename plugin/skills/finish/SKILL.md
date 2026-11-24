---
name: finish
description: Fechar um trabalho. Confere a evidência fresca, apresenta ao humano as saídas possíveis (revisão e entrega, commit local, rascunho de PR, manter a branch, descartar) e executa só a que ele escolher. Use quando o plano estiver todo cumprido.
---

# Fechar o trabalho

Terminar não é dizer "pronto". É **provar** e deixar o humano escolher o destino.

## 1. Prove antes de afirmar

- `jarvis_plan_progress`: todos os passos marcados, cada um por operações reais, e nenhuma mudança fora do plano.
- Rode as checagens obrigatórias de novo (`jarvis checks run <runId>`), porque qualquer edição depois do último verde as deixa velhas.
- Em bug: o teste que falhou antes e um que passa depois da última mudança.
- Só então diga que passou, **citando a saída que você viu agora**. "Deve funcionar" não vale.

## 2. Ofereça as saídas (uma recomendação, não um cardápio)

| Saída                 | Como                                                                                                                                                |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entregar para revisão | `jarvis run submit <runId>`, depois o humano revisa e conclui com `jarvis run complete`                                                             |
| Commit local          | `jarvis cycle commit <workItem> --base <ref> --head <ref>` gera o rascunho; o commit passa pelo JARVIS (aprovação, ou delegação se o dono permitiu) |
| Rascunho de PR        | `jarvis cycle pr <workItem> --base <ref> --head <ref>`; **o humano publica**, você não abre PR                                                      |
| Manter a branch       | não faz nada; registra onde o trabalho está                                                                                                         |
| Descartar             | só o humano, e só depois de ver o que se perde (worktree com trabalho não integrado nunca é removido em silêncio)                                   |

Recomende uma, com a razão em uma linha.

## 3. Nunca

- Push, merge ou PR sem pedido e aprovação do humano.
- Apagar branch ou worktree por conta própria.
- Declarar sucesso sem evidência gerada nesta sessão.
