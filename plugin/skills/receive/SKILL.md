---
name: receive
description: Receber uma revisão (do revisor cego ou de uma pessoa). Verifica cada item contra o código antes de implementar e discorda com razão técnica quando o item estiver errado. Use quando chegar feedback sobre o que foi entregue.
---

# Receber revisão

Revisão se avalia com rigor técnico, não com educação performática. O revisor cego não conhece a conversa e pode errar; uma pessoa pode estar certa por um motivo que você não viu. Em ambos os casos: **verifique antes de mexer**.

## Passo a passo

1. **Leia tudo** antes de reagir. Itens relacionados mudam o sentido uns dos outros.
2. **Reescreva cada item** com as suas palavras (ou pergunte). Se algum item estiver obscuro, **não implemente nenhum** até esclarecer: entender metade gera a correção errada.
3. **Confira no código**: o achado cita arquivo e linha que existem? O comportamento descrito é real? Achado sobre arquivo que não mudou ou passo que não existe no plano é descartável.
4. **Avalie para este projeto**: o item vale para este código e este plano, ou é gosto fora do escopo aprovado?
5. **Responda com fato**: aceite com a evidência ("confirmado em `arquivo:linha`") ou recuse com a razão técnica e a evidência. Nada de "ótimo ponto" nem "você tem toda razão" antes de verificar.
6. **Corrija um item por vez**, rodando o teste de cada um. Se a correção exigir sair do plano aprovado, peça um plano emendado: o JARVIS barra edição fora do plano.

## Lembretes do JARVIS

- A revisão cega é **consultiva**: ela não aprova nem recusa a entrega. Quem decide é o humano (`jarvis run complete`).
- Três correções seguidas que falham congelam o código (`FIX_LOOP_STOP:3`). Se um item de revisão levar a isso, o problema provavelmente é a causa, não o remendo.
- Você nunca aprova nada por conta própria.
