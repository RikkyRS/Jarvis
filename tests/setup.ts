import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Safety net: anything that defaults to the user's home (e.g. the learning journal) lands in a sandbox.
const sandbox = mkdtempSync(join(tmpdir(), "jarvis-home-"));
process.env["HOME"] = sandbox;
process.env["USERPROFILE"] = sandbox;
