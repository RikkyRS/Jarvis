export const LANGUAGE = "typescript";
export function detectManifests(): string[] {
  return ["package.json", "tsconfig.json"];
}
