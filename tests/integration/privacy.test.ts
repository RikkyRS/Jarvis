import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { privacyReport } from "../../src/app/privacy.js";
import type { Jarvis } from "../../src/app/jarvis.js";
import { cleanup, human, makeRepo, openJarvis, sh } from "../helpers.js";

let root: string;
let jarvis: Jarvis | undefined;
afterEach(() => {
  jarvis?.close();
  jarvis = undefined;
  cleanup(root);
});

describe("privacy of client data", () => {
  it("[R-PRIVACY-01] the state directory can never be committed, even if the project forgot to ignore it", () => {
    root = makeRepo();
    writeFileSync(join(root, ".gitignore"), ""); // the project does NOT ignore .jarvis/
    sh(root, "add", ".");
    sh(root, "commit", "-m", "no ignore", "--allow-empty");
    jarvis = openJarvis(root);
    jarvis.contract.add({
      kind: "CONTRACT",
      text: "Contrato confidencial do cliente, cláusula 1: objeto do serviço de agendamento.",
      sourceName: "c.md",
      actor: human,
    });
    expect(readFileSync(join(root, ".jarvis", ".gitignore"), "utf8")).toBe("*\n");
    expect(existsSync(join(root, ".jarvis", "state.sqlite"))).toBe(true);
    sh(root, "add", "-A");
    expect(sh(root, "status", "--porcelain")).toBe(""); // nothing from .jarvis/ is stageable
  });

  it("[R-PRIVACY-02] the report flags a cloud model and an exposed state directory, and is OK when local", () => {
    root = makeRepo();
    jarvis = openJarvis(root);
    const local = privacyReport(jarvis, { JARVIS_OLLAMA_MODEL: "qwen2.5:7b" });
    expect(local.some((f) => f.level === "OK" && /local model/.test(f.message))).toBe(true);
    expect(local.some((f) => f.level === "WARN")).toBe(false);

    const cloud = privacyReport(jarvis, { JARVIS_ALLOW_CLAUDE: "1" });
    expect(cloud.some((f) => f.level === "WARN" && /Anthropic/.test(f.message))).toBe(true);
  });

  it("[R-PRIVACY-02] the report warns about old processed messages kept as text", () => {
    root = makeRepo();
    jarvis = openJarvis(root);
    jarvis.db
      .prepare(
        `INSERT INTO inbox_messages (id, project_id, channel, external_id, sender, conversation_id, text, received_at, status)
         VALUES ('msg_old', ?, 'manual', 'x1', 's', 's', 'mensagem antiga do cliente', '2020-01-01T00:00:00.000Z', 'CLASSIFIED')`,
      )
      .run(jarvis.project.id);
    const findings = privacyReport(jarvis, {});
    expect(findings.some((f) => f.level === "WARN" && /retention apply/.test(f.message))).toBe(
      true,
    );
  });
});
