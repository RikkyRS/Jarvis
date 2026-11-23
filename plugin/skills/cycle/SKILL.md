---
name: cycle
description: Fecha o ciclo de desenvolvimento com rascunhos de mensagem de commit e descrição de PR, derivados do plano aprovado. Use quando pedirem commit, PR ou texto de entrega.
---

# Auxiliar de ciclo

Entra **só quando chamado**, não faz parte do pipeline. Produz rascunhos a partir do que o plano diz, sem inventar.

## Commit

```
jarvis cycle commit <workItem> --base <ref> --head <ref>
```

Formato `type(scope): description`, no máximo 3 linhas, primeira linha até 72 caracteres. O tipo vem do plano (`feat`, `fix`, `refactor`), o escopo da pasta mais alterada e, em bug, a segunda linha traz a causa.

## Pull request

```
jarvis cycle pr <workItem> --base <ref> --head <ref> [--lang pt|en]
```

Seções: o que muda e por quê, como testar (da estratégia de testes do plano), tipo de mudança, critérios de aceite, arquivos alterados, como desfazer e checklist. Se o projeto tiver `.github/PULL_REQUEST_TEMPLATE.md`, siga o modelo dele no lugar deste.

## Regras

- São **rascunhos**: o JARVIS não comita, não empurra e não abre PR. O humano revisa e executa.
- Se a estratégia de testes do plano estiver vazia, o rascunho avisa em vez de inventar passos.
- Resposta a comentário de code review: técnica, direta e sem defensividade, baseada no código e no plano.
