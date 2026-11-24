# Plugin JARVIS para Claude Code

Sete comandos de método que rodam **em cima** do runtime do JARVIS. O agente propõe; o JARVIS autoriza, executa e audita; o humano aprova o que é arriscado.

| Comando           | Para quê                                                                            |
| ----------------- | ----------------------------------------------------------------------------------- |
| `/jarvis:plan`    | Planejar: Certeza / Proposta / Dúvida, diagnóstico de bug, matriz de impacto        |
| `/jarvis:dev`     | Executar o plano aprovado, sempre pelo JARVIS                                       |
| `/jarvis:review`  | Revisão cega: só plano aprovado e código                                            |
| `/jarvis:cycle`   | Rascunho de commit e de PR, a partir do plano                                       |
| `/jarvis:toc`     | Mapear o repositório e achar documentação envelhecida                               |
| `/jarvis:receive` | Receber revisão: verificar cada item no código antes de implementar                 |
| `/jarvis:finish`  | Fechar o trabalho: provar com evidência fresca e deixar o humano escolher o destino |

## Instalar

1. Compile o JARVIS: `npm install && npm run build`.
2. Conecte o servidor MCP ao projeto que ele vai governar:
   ```bash
   claude mcp add jarvis -- node /caminho/absoluto/Jarvis/dist/cli/main.js mcp --client claude
   ```
   No Windows use caminho nativo (`C:/Users/voce/Jarvis/dist/cli/main.js`).
3. Habilite o plugin apontando para esta pasta (`plugin/`).

## Hook de sessão

`hooks/hooks.json` roda `jarvis context` ao iniciar, limpar ou compactar a sessão e entrega ao agente o estado do JARVIS (autonomia, aprovações esperando, Work Items e planos) e as regras do método. Em pasta sem `.jarvis/` ele não imprime nada e **não cria estado**.

## Privacidade

Modelos locais por padrão (`JARVIS_OLLAMA_MODEL`). Se você conectar o Claude Code por MCP, o texto das cláusulas do contrato que ele ler vai para a Anthropic. Veja [`docs/PRIVACIDADE.md`](../docs/PRIVACIDADE.md) e rode `jarvis privacy`.

## Créditos

O método (planejador, desenvolvedor fiel ao plano, revisor cego, auxiliar de ciclo, índice do repositório, separação Certeza / Proposta / Dúvida e matriz de impacto) foi desenhado **junto com o Gabriel (GitHub: Gabrieltupi)**, a partir do _personal harness_ dele. A parte que faz cumprir as regras (política, aprovação, auditoria, isolamento) é o runtime do JARVIS.
