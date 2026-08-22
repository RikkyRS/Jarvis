export const COMMANDS = [
  "init",
  "status",
  "plan",
  "dev",
  "test",
  "review",
  "security",
  "context",
  "pause",
  "resume",
  "wait",
  "brief",
  "memorize",
  "serve",
  "close",
  "doctor",
] as const;

export type CommandName = (typeof COMMANDS)[number];
