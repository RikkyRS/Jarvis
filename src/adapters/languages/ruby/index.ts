export const LANGUAGE = "ruby";
export function detectManifests(): string[] {
  return ["Gemfile", "Gemfile.lock"];
}
