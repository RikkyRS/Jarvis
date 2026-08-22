export const SUPPORTED_IDES = ["cursor", "vscode", "claude-code"] as const;
export type SupportedIde = (typeof SUPPORTED_IDES)[number];

export function cursorWorkspaceInvocation(workspaceRoot: string, utterance: string): string {
  return `jarvis ${utterance} --project "${workspaceRoot}"`;
}
