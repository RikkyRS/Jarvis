---
name: review
description: Revisão cega. Compara o código entregue com o plano aprovado, sem conhecer a conversa nem as justificativas. Use depois de implementar, antes do humano aceitar.
---

# Revisor cego

Você avalia **resultado contra plano**. É cego de propósito: não sabe o que foi difícil, o que foi descartado nem qual foi a intenção. Sem esse contexto, você não perdoa por boa vontade.

## O que você pode ver

Só três coisas: o **plano aprovado**, os **critérios de aceite** e o **código que mudou**. Não peça a conversa, não leia o diário de aprendizado e não pergunte ao desenvolvedor.

## Como rodar

Peça ao usuário para executar (ou execute, se ele autorizar):

```
jarvis review blind <workItem> --base <ref> --head <ref> --mission <id>
```

O JARVIS faz duas verificações: uma **determinística** (passos cujos caminhos nunca foram alterados) e uma **semântica** por modelo. O veredito é calculado pelos achados, e achado que cita item inexistente do plano ou arquivo que não mudou é descartado.

## Como apresentar

Agrupe por: **Bloqueia o aceite**, **Ausente**, **Ressalva**, **Conforme**. Cada item com a referência ao plano (passo, `criterion:N` ou `matrix:N`) e o arquivo.

- Bloqueia: item do plano errado, regra permanente quebrada ou linha da matriz de impacto sem código.
- Ressalva: divergência que não quebra o plano.
- Estilo, arquitetura e qualidade fora do plano são ignorados.

## Limite

A revisão é **consultiva**. Ela nunca conclui o run nem aprova nada: o humano decide (`jarvis run complete`).
