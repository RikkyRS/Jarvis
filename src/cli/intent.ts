import { COMMANDS, type CommandName } from "../shared/commands.js";

const ALIASES: Record<string, CommandName> = {
  plan: "plan",
  planeje: "plan",
  planejar: "plan",
  planeja: "plan",
  planejamento: "plan",
  dev: "dev",
  desenvolva: "dev",
  desenvolver: "dev",
  desenvolve: "dev",
  implemente: "dev",
  implementar: "dev",
  implementa: "dev",
  test: "test",
  teste: "test",
  testar: "test",
  testes: "test",
  review: "review",
  revise: "review",
  revisar: "review",
  revisao: "review",
  revisão: "review",
  security: "security",
  seguranca: "security",
  segurança: "security",
  context: "context",
  contexto: "context",
  close: "close",
  feche: "close",
  fechar: "close",
  encerre: "close",
  encerrar: "close",
  status: "status",
  estado: "status",
  init: "init",
  inicie: "init",
  iniciar: "init",
  inicialize: "init",
  inicializar: "init",
  doctor: "doctor",
  diagnostico: "doctor",
  diagnóstico: "doctor",
  pause: "pause",
  pausa: "pause",
  pausar: "pause",
  resume: "resume",
  retomar: "resume",
  retome: "resume",
  continuar: "resume",
  wait: "wait",
  aguarde: "wait",
  aguardar: "wait",
  esperar: "wait",
  brief: "brief",
  resumo: "brief",
  memorize: "memorize",
  memorizar: "memorize",
  memoriza: "memorize",
  lembrar: "memorize",
  serve: "serve",
  servidor: "serve",
  logs: "logs",
  log: "logs",
  historico: "logs",
  reconcile: "reconcile",
  reconciliar: "reconcile",
};

function normalize(token: string): string {
  return token
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

export function resolveIntent(positionals: string[]): { command: CommandName; rest: string[] } | null {
  const tokens = positionals.filter((item) => normalize(item) !== "jarvis");
  if (tokens.length === 0) return null;
  const first = normalize(tokens[0] ?? "");
  if (COMMANDS.includes(first as CommandName)) {
    return { command: first as CommandName, rest: tokens.slice(1) };
  }
  for (let index = 0; index < tokens.length; index += 1) {
    const alias = ALIASES[normalize(tokens[index] ?? "")];
    if (alias) {
      return { command: alias, rest: tokens.slice(index + 1) };
    }
  }
  return null;
}
