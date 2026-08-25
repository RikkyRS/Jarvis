import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { nowIso, shortId } from "../shared/util.js";

export type GlobalShareRecord = {
  id: string;
  subjectKind: "github" | "cycle";
  subjectKey: string;
  channel: string;
  status: "DRAFT" | "POSTED";
  draftPath: string | null;
  draftText: string;
  postedAt: string | null;
  createdAt: string;
  updatedAt: string;
  meta?: {
    repoUrl?: string;
    projectName?: string;
  };
};

export type GlobalShareStore = {
  schemaVersion: 1;
  items: GlobalShareRecord[];
};

function jarvisHome(): string {
  return process.env.JARVIS_HOME?.trim() || join(homedir(), ".jarvis");
}

export function globalSharesPath(): string {
  return join(jarvisHome(), "shares.json");
}

export function globalSharesDir(): string {
  return join(jarvisHome(), "shares");
}

function emptyStore(): GlobalShareStore {
  return { schemaVersion: 1, items: [] };
}

export function readGlobalShares(): GlobalShareStore {
  const path = globalSharesPath();
  if (!existsSync(path)) return emptyStore();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as GlobalShareStore;
    if (!parsed || !Array.isArray(parsed.items)) return emptyStore();
    return { schemaVersion: 1, items: parsed.items };
  } catch {
    return emptyStore();
  }
}

function writeGlobalShares(store: GlobalShareStore): void {
  mkdirSync(jarvisHome(), { recursive: true });
  writeFileSync(globalSharesPath(), `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

export function getGlobalShare(
  subjectKind: GlobalShareRecord["subjectKind"],
  subjectKey: string,
  channel: string,
): GlobalShareRecord | undefined {
  const key = subjectKey.toLowerCase();
  return readGlobalShares().items.find(
    (item) => item.subjectKind === subjectKind && item.subjectKey.toLowerCase() === key && item.channel === channel,
  );
}

export function upsertGlobalShare(
  input: Omit<GlobalShareRecord, "id" | "createdAt" | "updatedAt"> & {
    id?: string;
    createdAt?: string;
  },
): GlobalShareRecord {
  const store = readGlobalShares();
  const key = input.subjectKey;
  const existingIndex = store.items.findIndex(
    (item) =>
      item.subjectKind === input.subjectKind &&
      item.subjectKey.toLowerCase() === key.toLowerCase() &&
      item.channel === input.channel,
  );
  const now = nowIso();
  if (existingIndex >= 0) {
    const prev = store.items[existingIndex]!;
    const next: GlobalShareRecord = {
      ...prev,
      status: input.status === "POSTED" ? "POSTED" : input.status,
      draftPath: input.draftPath,
      draftText: input.draftText,
      postedAt: input.status === "POSTED" ? (input.postedAt ?? prev.postedAt) : prev.postedAt,
      updatedAt: now,
      ...(input.meta ? { meta: { ...prev.meta, ...input.meta } } : prev.meta ? { meta: prev.meta } : {}),
    };
    if (input.status === "POSTED" && input.postedAt) next.postedAt = input.postedAt;
    store.items[existingIndex] = next;
    writeGlobalShares(store);
    return next;
  }
  const created: GlobalShareRecord = {
    id: input.id ?? shortId("gshare"),
    subjectKind: input.subjectKind,
    subjectKey: key,
    channel: input.channel,
    status: input.status,
    draftPath: input.draftPath,
    draftText: input.draftText,
    postedAt: input.postedAt,
    createdAt: input.createdAt ?? now,
    updatedAt: now,
    ...(input.meta ? { meta: input.meta } : {}),
  };
  store.items.unshift(created);
  writeGlobalShares(store);
  return created;
}

export function markGlobalSharePosted(
  subjectKind: GlobalShareRecord["subjectKind"],
  subjectKey: string,
  channel: string,
  postedAt = nowIso(),
): GlobalShareRecord | null {
  const existing = getGlobalShare(subjectKind, subjectKey, channel);
  if (!existing) return null;
  return upsertGlobalShare({
    ...existing,
    status: "POSTED",
    postedAt,
  });
}

export function listGlobalShares(channel?: string, limit = 100): GlobalShareRecord[] {
  const items = readGlobalShares().items.filter((item) => (channel ? item.channel === channel : true));
  return items.slice(0, limit);
}
