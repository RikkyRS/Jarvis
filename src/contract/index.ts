import type { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import type { Principal } from "../domain/contracts.js";
import { newId } from "../domain/ids.js";
import { containsSecret } from "../knowledge/index.js";
import type { AuditLog } from "../persistence/audit.js";
import { inTransaction } from "../persistence/db.js";
import { DomainError } from "../persistence/repositories.js";
import { sha256Hex } from "../shared/canonical.js";
import { systemClock, type Clock } from "../shared/clock.js";

/**
 * Per-project contract memory: the contract, the agreed scope and the history of what was already
 * delivered or complained about. It belongs to ONE project (never shared across projects) and only
 * a human principal can add to it. Agents can search it, never change it. Its text is evidence for
 * a decision, never an instruction.
 *
 * Only the CURRENT version of each document is searched. Older versions stay stored and audited,
 * so a past decision can be traced to the exact text that was in force, but they are not consulted.
 */

export type ContractKind = "CONTRACT" | "SCOPE" | "HISTORY";
export const CONTRACT_KINDS: readonly ContractKind[] = ["CONTRACT", "SCOPE", "HISTORY"];

export type ContractDoc = {
  id: string;
  kind: ContractKind;
  version: number;
  title: string;
  sourceName: string;
  sha256: string;
  status: "CURRENT" | "SUPERSEDED";
  addedBy: string;
  addedAt: string;
  chunks: number;
};

export type ContractHit = {
  chunkId: string;
  docId: string;
  kind: ContractKind;
  version: number;
  ref: string;
  text: string;
  score: number;
};

const MAX_CHARS = 1200;
const MAX_DOC_BYTES = 2 * 1024 * 1024;
const CLAUSE_START =
  /^(#{1,6}\s|cl[áa]usula\b|art(igo|\.)\b|\d+(\.\d+)*[.)]\s|[IVXLC]+\s*[-–.)]\s)/i;

/** Splits a document at headings and numbered clauses; long blocks are cut at paragraph boundaries. */
export function chunkText(text: string): { ref: string; text: string }[] {
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (CLAUSE_START.test(line.trim()) && current.some((l) => l.trim() !== "")) {
      blocks.push(current);
      current = [];
    }
    current.push(line);
  }
  if (current.some((l) => l.trim() !== "")) blocks.push(current);

  const out: { ref: string; text: string }[] = [];
  for (const block of blocks) {
    const body = block.join("\n").trim();
    if (!body) continue;
    const ref = (block.find((l) => l.trim() !== "") ?? "")
      .trim()
      .replace(/^#+\s*/, "")
      .slice(0, 80);
    if (body.length <= MAX_CHARS) {
      out.push({ ref, text: body });
      continue;
    }
    let buffer = "";
    for (const paragraph of body.split(/\n\s*\n/)) {
      if (buffer && buffer.length + paragraph.length > MAX_CHARS) {
        out.push({ ref, text: buffer.trim() });
        buffer = "";
      }
      buffer += `${paragraph}\n\n`;
      while (buffer.length > MAX_CHARS * 2) {
        out.push({ ref, text: buffer.slice(0, MAX_CHARS).trim() });
        buffer = buffer.slice(MAX_CHARS);
      }
    }
    if (buffer.trim()) out.push({ ref, text: buffer.trim() });
  }
  return out;
}

const STOP = new Set([
  "para",
  "como",
  "esta",
  "esse",
  "essa",
  "isso",
  "mais",
  "pelo",
  "pela",
  "with",
  "that",
  "this",
  "from",
]);
const tokens = (s: string): string[] =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3 && !STOP.has(w));

/** Reads a contract file: Markdown/text directly, PDF through `pdftotext` (no extra dependency). */
export function readContractFile(path: string): { text: string; sourceName: string } {
  const size = statSync(path).size;
  if (size > MAX_DOC_BYTES) throw new DomainError("Contract file is larger than 2 MB.");
  const ext = extname(path).toLowerCase();
  const sourceName = path.split(/[\\/]/).pop() ?? path;
  if (ext === ".md" || ext === ".txt" || ext === "") {
    return { text: readFileSync(path, "utf8"), sourceName };
  }
  if (ext === ".pdf") {
    let text: string;
    try {
      text = execFileSync("pdftotext", ["-layout", path, "-"], {
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      });
    } catch {
      throw new DomainError(
        "Could not read the PDF. Install poppler (pdftotext) or send the contract as text/Markdown.",
      );
    }
    if (text.trim().length < 20)
      throw new DomainError("The PDF has no extractable text (a scan?). Send it as text/Markdown.");
    return { text, sourceName };
  }
  throw new DomainError(`Unsupported file type ${ext}. Use .md, .txt or .pdf.`);
}

type DocRow = {
  id: string;
  kind: ContractKind;
  version: number;
  title: string;
  source_name: string;
  sha256: string;
  status: "CURRENT" | "SUPERSEDED";
  added_by: string;
  added_at: string;
  chunks?: number;
};

export class ContractStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly audit: AuditLog,
    private readonly projectId: string,
    private readonly clock: Clock = systemClock,
  ) {}

  /**
   * Human only. A new version of a kind replaces the previous one as the one consulted; the old
   * one is kept as SUPERSEDED. Adding identical text again changes nothing.
   */
  add(input: {
    kind: ContractKind;
    text: string;
    sourceName: string;
    title?: string;
    actor: Principal;
  }): { doc: ContractDoc; created: boolean } {
    if (input.actor.kind !== "human")
      throw new DomainError("Only a human principal can add contract documents.");
    if (!CONTRACT_KINDS.includes(input.kind)) throw new DomainError("Unknown contract kind.");
    const text = input.text.trim();
    if (text.length < 20) throw new DomainError("The document is empty.");
    if (containsSecret(text))
      throw new DomainError(
        "The document contains something that looks like a secret; remove it first.",
      );

    const sha256 = sha256Hex(text);
    const current = this.db
      .prepare(
        "SELECT * FROM contract_docs WHERE project_id = ? AND kind = ? AND status = 'CURRENT'",
      )
      .get(this.projectId, input.kind) as DocRow | undefined;
    if (current && current.sha256 === sha256) return { doc: this.toDoc(current), created: false };

    const chunks = chunkText(text);
    if (chunks.length === 0) throw new DomainError("No readable content found.");
    const id = newId("cdoc");
    const version = this.lastVersion(input.kind) + 1;
    const at = this.clock().toISOString();

    inTransaction(this.db, () => {
      if (current)
        this.db
          .prepare("UPDATE contract_docs SET status = 'SUPERSEDED' WHERE id = ?")
          .run(current.id);
      this.db
        .prepare(
          `INSERT INTO contract_docs (id, project_id, kind, version, title, source_name, sha256, status, added_by, added_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'CURRENT', ?, ?)`,
        )
        .run(
          id,
          this.projectId,
          input.kind,
          version,
          input.title ?? input.sourceName,
          input.sourceName,
          sha256,
          input.actor.id,
          at,
        );
      const insert = this.db.prepare(
        "INSERT INTO contract_chunks (id, doc_id, project_id, ordinal, ref, text) VALUES (?, ?, ?, ?, ?, ?)",
      );
      chunks.forEach((c, i) => insert.run(newId("cchk"), id, this.projectId, i, c.ref, c.text));
      this.audit.append({
        projectId: this.projectId,
        kind: "contract.added",
        actor: input.actor,
        subject: id,
        payload: {
          kind: input.kind,
          version,
          sha256,
          chunks: chunks.length,
          supersedes: current?.id ?? null,
        },
      });
    });
    const row = this.db.prepare("SELECT * FROM contract_docs WHERE id = ?").get(id) as DocRow;
    return { doc: { ...this.toDoc(row), chunks: chunks.length }, created: true };
  }

  private lastVersion(kind: ContractKind): number {
    const row = this.db
      .prepare("SELECT MAX(version) AS v FROM contract_docs WHERE project_id = ? AND kind = ?")
      .get(this.projectId, kind) as { v: number | null };
    return row.v ?? 0;
  }

  /** Documents of this project; by default only the ones in force. */
  list(opts: { includeSuperseded?: boolean } = {}): ContractDoc[] {
    const rows = this.db
      .prepare(
        `SELECT d.*, (SELECT COUNT(*) FROM contract_chunks c WHERE c.doc_id = d.id) AS chunks
         FROM contract_docs d WHERE d.project_id = ? ${opts.includeSuperseded ? "" : "AND d.status = 'CURRENT'"}
         ORDER BY d.kind, d.version DESC`,
      )
      .all(this.projectId) as DocRow[];
    return rows.map((r) => this.toDoc(r));
  }

  /**
   * Selective retrieval over CURRENT documents only: the caller gets the few clauses that matter,
   * with their document, version and clause label, never the whole contract.
   */
  retrieve(
    query: string,
    opts: { kinds?: readonly ContractKind[]; limit?: number } = {},
  ): ContractHit[] {
    const q = new Set(tokens(query));
    if (q.size === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT c.id AS chunk_id, c.doc_id, c.ref, c.text, d.kind, d.version
         FROM contract_chunks c JOIN contract_docs d ON d.id = c.doc_id
         WHERE c.project_id = ? AND d.status = 'CURRENT'`,
      )
      .all(this.projectId) as {
      chunk_id: string;
      doc_id: string;
      ref: string;
      text: string;
      kind: ContractKind;
      version: number;
    }[];
    const wanted = opts.kinds ? new Set(opts.kinds) : null;
    const hits: ContractHit[] = [];
    for (const r of rows) {
      if (wanted && !wanted.has(r.kind)) continue;
      const words = new Set(tokens(`${r.ref} ${r.text}`));
      let overlap = 0;
      for (const w of q) if (words.has(w)) overlap += 1;
      if (overlap === 0) continue;
      hits.push({
        chunkId: r.chunk_id,
        docId: r.doc_id,
        kind: r.kind,
        version: r.version,
        ref: r.ref,
        text: r.text,
        score: overlap / Math.sqrt(words.size || 1),
      });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, opts.limit ?? 5);
  }

  /** Text of specific clauses (for citing them), restricted to this project. */
  chunksByIds(ids: readonly string[]): ContractHit[] {
    const out: ContractHit[] = [];
    const stmt = this.db.prepare(
      `SELECT c.id AS chunk_id, c.doc_id, c.ref, c.text, d.kind, d.version
       FROM contract_chunks c JOIN contract_docs d ON d.id = c.doc_id
       WHERE c.id = ? AND c.project_id = ?`,
    );
    for (const id of ids) {
      const r = stmt.get(id, this.projectId) as
        | {
            chunk_id: string;
            doc_id: string;
            ref: string;
            text: string;
            kind: ContractKind;
            version: number;
          }
        | undefined;
      if (r)
        out.push({
          chunkId: r.chunk_id,
          docId: r.doc_id,
          kind: r.kind,
          version: r.version,
          ref: r.ref,
          text: r.text,
          score: 1,
        });
    }
    return out;
  }

  private toDoc(r: DocRow): ContractDoc {
    return {
      id: r.id,
      kind: r.kind,
      version: r.version,
      title: r.title,
      sourceName: r.source_name,
      sha256: r.sha256,
      status: r.status,
      addedBy: r.added_by,
      addedAt: r.added_at,
      chunks: r.chunks ?? 0,
    };
  }
}
