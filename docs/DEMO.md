# Demo: um tour pela CLI

Reproduza com `npm run build && bash scripts/demo.sh`. O script cria um repositório descartável, roda os comandos abaixo e apaga tudo no final. A saída é real (IDs mudam a cada execução).

Mostra: projeto e cadeia de auditoria verificada, criação de um Work Item, Mission, concessão de orçamento de tokens pelo humano, varredura do projeto e verificação da auditoria.

```text

$ jarvis status
{
  "project": {
    "id": "prj_5e8426ab-2892-4604-9f53-bf763b817d2c",
    "name": "demo",
    "root": "<repo temporário>"
  },
  "trustedProject": false,
  "workItems": {},
  "pendingApprovals": 0,
  "auditChain": "VERIFIED"
}

$ jarvis work create Fix totals --objective Report totals ignore discounts --accept totals match the invoice
wi_a7b3371d-8521-45be-9ebd-b293e93d03e6

$ jarvis work list
wi_a7b3371d-8521-45be-9ebd-b293e93d03e6  OPEN        Fix totals

$ jarvis mission create   # -> mis_b20df8d3-5dfa-4786-9649-6861d6ea2829

$ jarvis budget grant mis_b20df8d3-5dfa-4786-9649-6861d6ea2829 EXECUTION 80000 --reason approved scope v1
grt_3b851916-bd48-465a-a2a7-e64cd0974b35

$ jarvis budget status mis_b20df8d3-5dfa-4786-9649-6861d6ea2829 EXECUTION
{
  "missionId": "mis_b20df8d3-5dfa-4786-9649-6861d6ea2829",
  "phase": "EXECUTION",
  "allowance": 80000,
  "used": 0,
  "reserved": 0,
  "remaining": 80000,
  "criticalReserve": 0,
  "level": "NORMAL"
}

$ jarvis scan
0 claims. Re-analyzed: nothing. Dropped: nothing.

$ jarvis audit verify
Audit chain verified.
```

## O fluxo de aprovação (com um agente de IA, via MCP)

A parte que a CLI sozinha não mostra: o agente **pede**, o humano **decide**.

```bash
claude mcp add jarvis -- node C:/caminho/Jarvis/dist/cli/main.js mcp --client claude
```

1. O agente chama `jarvis_request_operation` para um commit e recebe `APPROVAL_REQUIRED` com um `approvalId`.
2. Você roda `jarvis approvals` (mostra os parâmetros exatos) e `jarvis approve <id>`.
3. O agente chama `jarvis_resume_operation`; o gateway reverifica tudo e executa **uma única vez**.

O MCP não expõe nenhuma ferramenta de aprovar, conceder orçamento ou mudar política: é o requisito `R-MCP-01`.

Para gravar um GIF desta sequência, rode o script com um gravador de terminal (por exemplo `asciinema rec`) e converta o resultado.
