export function runCycleCapability(kind: "close" | "abandon") {
  return { name: "cycle", status: "SUCCEEDED" as const, output: { kind } };
}
