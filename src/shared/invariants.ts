export const INVARIANTS = [
  "Evidence-First / No Hallucinated State is the primary rule.",
  "Without sufficient evidence, JARVIS must investigate, request context, or record UNKNOWN.",
  "Security cannot be reduced by speed, autonomy, preference, or token savings.",
  "HIGH operations require explicit approval; CRITICAL is blocked until explicit treatment.",
  "Maximum of 3 attempts per logical operation; repeated states/actions must also detect loops.",
  "No pre-existing human change may be deleted, overwritten, reset, stashed, or discarded automatically.",
  "JARVIS is agnostic of IDE, provider, model, and stack.",
  "TypeScript, Python, and Ruby must be supported without assuming a specific toolchain.",
  "Only one session may control an open Cycle.",
  "No Capability or Tool controls the whole Cycle; the Orchestrator owns the flow.",
  "Do not start an important implementation while an architectural decision remains open.",
] as const;

export const MAX_RETRIES_PER_LOGICAL_OPERATION = 3;
export const IDENTICAL_FINGERPRINT_LOOP_THRESHOLD = 3;
export const CONTRACT_VERSION = 1;
export const SCHEMA_VERSION = 1;
export const JARVIS_VERSION = "0.3.0";

export const IDENTITY = {
  name: "JARVIS",
  role: "runtime_control_layer",
  version: JARVIS_VERSION,
  ownsModel: false,
  ownsIde: false,
  ownsCredentials: false,
  providerAgnostic: true,
  ideAgnostic: true,
  stackAgnostic: true,
  evidencePolicy: "EVIDENCE_FIRST",
} as const;
