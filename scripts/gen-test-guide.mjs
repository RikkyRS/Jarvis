// Generates docs/TESTES-EXPLICADOS.md from the real test results.
// Usage: npx vitest run --reporter=json --outputFile=vt.json && node scripts/gen-test-guide.mjs vt.json
import { readFileSync, writeFileSync } from "node:fs";

const raw = readFileSync(process.argv[2] ?? "vt.json", "utf8");
const j = JSON.parse(raw.slice(raw.indexOf("{")));

const about = {
  "e2e/cli-lifecycle": "Ciclo de vida inteiro dirigido só pela CLI humana",
  "e2e/full-flow":
    "Fluxos completos: Mission, run, edição, teste, commit aprovado, revisão, entrega e reabertura",
  "e2e/protected-paths": "Tentativas de escrever em arquivos de controle do JARVIS (`.jarvis/`)",
  "integration/adapters": "Adaptadores CLI e MCP: o que o agente pode e não pode pedir",
  "integration/ai-runtime":
    "Runtime de IA: roteador, orçamento, loops, scheduler, provedores e perfil de isolamento Docker",
  "integration/docker-live":
    "Isolamento contra um daemon Docker real (roda no CI; local só com Docker ligado)",
  "integration/domain-budget": "Projetos, Missions, Work Items e orçamento de tokens",
  "integration/gateway":
    "Execution Gateway: política, caminhos, aprovação, replay, evidência, ambiente",
  "integration/git": "Git e worktrees: hooks, push, commit aprovado, perda de trabalho",
  "integration/intake": "Mensagens externas (WhatsApp): são dado não confiável e viram proposta",
  "integration/interpretation":
    "Interpretação do Resolver por LLM: consultiva, sem poder de decisão",
  "integration/plan-steps": "Passos do plano comprovados por operações reais",
  "integration/planning-notes": "Planning gate e diário de aprendizado",
  "integration/providers-http": "Adaptador Ollama sobre conexão HTTP real",
  "integration/providers-live": "Ollama e Claude Code reais (opt-in; ignorados no CI)",
  "integration/resolver-knowledge": "Integration Resolver e base de conhecimento do projeto",
  "recovery/recovery": "Recuperação: reinício, auditoria adulterada, corridas entre processos",
  "unit/domain": "Regras de domínio: política, estado e hash canônico",
  "unit/requirements": "Análise de requisitos",
  "unit/traceability": "Rastreabilidade: todo requisito crítico tem teste e vice-versa",
};

const files = j.testResults
  .map((f) => ({
    key: f.name
      .split("\\")
      .join("/")
      .split("/tests/")[1]
      .replace(/\.test\.ts$/, ""),
    tests: f.assertionResults,
  }))
  .sort((a, b) => a.key.localeCompare(b.key));

const total = j.numTotalTests;
const pass = j.numPassedTests;
const skip = j.numPendingTests;

let out = `# Os testes do JARVIS, por área

Este arquivo substitui o guia antigo (que explicava os 57 testes da Geração 1). Ele é **gerado dos testes reais** da Geração 2 por \`scripts/gen-test-guide.mjs\`: **${total} testes, ${pass} passando, ${skip} ignorados**. Os ignorados são verificações opt-in que dependem de Docker, Ollama ou Claude Code reais.

Como ler: cada título descreve o comportamento garantido. Os que começam com \`[R-...]\` são **requisitos críticos** da matriz em [\`TESTING.md\`](TESTING.md); \`tests/unit/traceability.test.ts\` falha se um requisito ficar sem teste.

Rodar tudo: \`npm test\`. Rodar contra os backends reais:

\`\`\`bash
JARVIS_OLLAMA_MODEL=qwen2.5:3b npm test                          # Ollama de verdade
JARVIS_CLAUDE_LIVE=1 npm test                                    # Claude Code de verdade (poucos tokens do seu plano)
JARVIS_DOCKER_IMAGE="node:22-alpine@sha256:<digest>" npm test    # isolamento com Docker real (já roda no CI)
\`\`\`

| Área | Testes |
|---|---:|
`;
for (const f of files) out += `| \`${f.key}\` | ${f.tests.length} |\n`;
out += `| **Total** | **${total}** |\n`;

for (const f of files) {
  out += `\n---\n\n## \`${f.key}\` (${f.tests.length})\n\n${about[f.key] ?? ""}\n\n`;
  for (const t of f.tests) {
    const skipped = t.status === "pending" || t.status === "skipped";
    out += `- ${skipped ? "(ignorado) " : ""}${t.title}\n`;
  }
}
writeFileSync("docs/TESTES-EXPLICADOS.md", out);
console.log({ total, pass, skip, files: files.length });
