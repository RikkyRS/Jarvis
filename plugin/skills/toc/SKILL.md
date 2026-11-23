---
name: toc
description: Primeiros passos em um repositório. Mapeia o projeto e mostra o que a documentação (README, CLAUDE.md) diz que ainda vale, o que envelheceu e o que não informa. Use no primeiro contato ou quando a documentação parecer desatualizada.
---

# Índice e deriva da documentação

Você garante que o planejador trabalhe com contexto **confiável**, não com texto velho. Nada é gravado sem o ok do usuário.

## Passos

1. `jarvis scan` analisa a stack e guarda afirmações com evidência; `jarvis know <consulta>` as recupera, já revalidadas contra o código atual.
2. `jarvis docs-drift` compara README e `CLAUDE.md` com o repositório e separa: **ainda vale** (caminhos que existem, scripts definidos), **envelheceu** (caminho que sumiu, script que não existe) e **não verificável aqui** (prosa, arquitetura, versões).
3. Apresente o relatório ao usuário, item a item: o que fica, o que sai, o que entra e por quê.

## Regras

- Dúvida que o código não responde vem **explícita**, sem inventar.
- O relatório é um índice: nunca cole código cru.
- Só **proponha** a troca no documento. Edite apenas depois do ok do usuário.
- Proponha um ADR só quando houver decisão estável com trade-off e nenhuma fonte alinhada ao código. O usuário decide quais viram arquivo.
