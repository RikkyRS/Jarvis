# Privacidade: para onde vão as mensagens e o contrato

"Totalmente seguro" não existe. O que existe é saber **exatamente por onde o dado passa**, reduzir esse caminho ao mínimo e conferir. Este guia diz o que o JARVIS garante, o que ele não controla e o que você precisa fazer.

Confira o seu estado atual a qualquer momento com `jarvis privacy` (só lê, não altera nada).

---

## 1. O caminho de uma mensagem

```
Cliente (WhatsApp)
   │   ① passa pelos servidores da Meta (fora do controle do JARVIS)
   ▼
Webhook público (túnel)           ← só existe se você usar a API oficial
   │   ② assinatura verificada (HMAC); remetente precisa estar na lista permitida
   ▼
JARVIS, no seu computador
   │   ③ guarda em .jarvis/state.sqlite (só nesta máquina)
   ▼
Modelo local (Ollama, só loopback)  ← a mensagem não sai do computador
   ▼
Proposta + veredito de escopo       ← você decide; nada executa sem a sua aprovação
```

## 2. O que o JARVIS garante (e há teste para cada item)

| Garantia                                              | Como                                                                                                                      |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Ninguém commita as mensagens ou o contrato por engano | `.jarvis/` ganha o próprio `.gitignore` (`*`), mesmo que o projeto esqueça (`R-PRIVACY-01`)                               |
| Por padrão as mensagens ficam locais                  | Só Ollama em loopback. Claude Code só com `JARVIS_ALLOW_CLAUDE=1`, de propósito                                           |
| O modelo nunca fala com a internet sem você pedir     | O Ollama recusa endereço que não seja local, salvo autorização explícita                                                  |
| Só remetentes permitidos geram propostas              | Os outros são guardados como ignorados                                                                                    |
| Webhook falso é recusado                              | Assinatura HMAC-SHA256 verificada em tempo constante antes de ler qualquer coisa                                          |
| A auditoria não vaza conteúdo                         | Guarda identificadores, nunca o texto da mensagem                                                                         |
| O contrato só é alterado por você                     | Só humano adiciona; agente só lê (`R-CONTRACT-02`)                                                                        |
| Um projeto nunca vê o contrato de outro               | Isolamento por projeto (`R-CONTRACT-03`)                                                                                  |
| Segredos não entram no contrato                       | Documentos com chaves/senhas são recusados                                                                                |
| O JARVIS não envia mensagem a ninguém                 | Não existe caminho de envio; a resposta é só rascunho (`R-INTAKE-04`)                                                     |
| Mensagem de cliente não executa nada                  | Texto é dado; vira, no máximo, uma proposta que você confirma                                                             |
| Mensagens antigas deixam de existir como texto        | `jarvis retention apply --days N` troca o texto por um hash                                                               |
| `jarvis privacy` avisa o que estiver exposto          | Modelo na nuvem, dados visíveis a outros usuários, diário dentro do projeto, mensagens antigas guardadas (`R-PRIVACY-02`) |

## 3. O que o JARVIS NÃO controla

Seja honesto com você mesmo sobre estes pontos:

1. **A Meta.** Com a API oficial, as mensagens também passam pelos servidores da Meta. Não é a mesma coisa que o WhatsApp pessoal com criptografia de ponta a ponta entre as duas pessoas.
2. **O túnel.** Para a Meta alcançar o seu computador é preciso uma URL pública. O provedor do túnel (por exemplo, Cloudflare) vê o tráfego em trânsito. O conteúdo continua protegido por HTTPS, mas o provedor termina essa conexão.
3. **O seu computador.** Os dados ficam em um arquivo SQLite **sem criptografia**. Quem tiver acesso à sua conta do Windows, ao disco ou a um backup pode ler. Proteja com **BitLocker**, senha forte, bloqueio de tela e cuidado com backups na nuvem (OneDrive, Google Drive) que incluam a pasta do projeto.
4. **Clientes de IA via MCP.** Se você conectar o Claude Code (ou outro) ao JARVIS por MCP, ele pode ler cláusulas do contrato pela ferramenta `jarvis_project_contract`, e esse texto vai para o modelo daquele cliente. Contrato confidencial: só conecte cliente local.
5. **Qualidade do modelo.** Um modelo local pequeno pode errar o veredito. Por isso toda conclusão cita a evidência, e sem evidência o resultado é "não sei" e você decide.

## 4. O que você deve fazer

- Rodar `jarvis privacy` depois de configurar e quando mudar algo.
- Ligar o **BitLocker** (ou criptografia de disco equivalente).
- Manter o projeto fora de pastas sincronizadas na nuvem, ou excluir `.jarvis/` da sincronização.
- Usar **Ollama** para conversas de cliente. Não definir `JARVIS_ALLOW_CLAUDE` para esse projeto.
- Agendar `jarvis retention apply --days 30` (ou o prazo que fizer sentido).
- Avisar o cliente de que um assistente local organiza os pedidos, e manter a lista de remetentes permitidos só com quem deve poder pedir.
- Não colocar o servidor do webhook em um computador compartilhado.

## 5. Decisões que dependem de você

- **Criptografar o banco no próprio JARVIS** (senha ao abrir, chave só na memória). Protege contra cópia do arquivo, mas é uma senha a mais a cada uso e, se você a perder, os dados se perdem. Hoje a recomendação é BitLocker; diga se quer também a camada do JARVIS.
- **Retenção automática** (apagar o texto sozinho após N dias) em vez de só sob comando.
- **Canal sem webhook:** você encaminha as mensagens ao JARVIS (`jarvis inbox add`). Não abre nenhuma porta para a internet, é a opção de menor superfície, ao custo de ser manual.
