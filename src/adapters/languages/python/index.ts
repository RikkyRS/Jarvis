export const LANGUAGE = "python";
export function detectManifests(): string[] {
  return ["pyproject.toml", "requirements.txt"];
}
