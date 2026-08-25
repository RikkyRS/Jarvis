import { existsSync } from "node:fs";
import { IDENTITY, JARVIS_VERSION } from "../shared/invariants.js";
import { nowIso, shortId } from "../shared/util.js";
import type { CommandName } from "../shared/commands.js";
import { initHarness, isInitialized } from "../infrastructure/harness.js";
import { sqlitePath, Store, LATEST_SCHEMA_VERSION } from "../infrastructure/db.js";
import { resolveSessionId } from "../infrastructure/session.js";
import { loadProjectPolicy } from "../infrastructure/project-policy.js";
import { briefCachePath } from "../infrastructure/brief-cache.js";
import { GitEngine } from "../engines/git/index.js";
import { discoverContext } from "../engines/context/index.js";
import { analyzeImpact } from "../engines/impact/index.js";
import { scanSecurity } from "../engines/security/index.js";
import { assessRisk, accumulateRisk } from "../engines/risk/index.js";
import { decidePermission } from "../engines/permission/index.js";
import { recallMemory, recordMemory, promoteToGlobal } from "../engines/memory/index.js";
import { runTests } from "../engines/test/index.js";
import { buildContract } from "../engines/contract/index.js";
import { observe } from "../engines/observability/index.js";
import { buildTimeline } from "../engines/observability/logs.js";
import { fetchChecks, probeGh } from "../engines/git/gh.js";
import { exportCyclePack, importCyclePack, writeActiveCycleMeta } from "../engines/cycle-pack/index.js";
import {
  SHARE_CHANNEL_LINKEDIN,
  createLinkedInDraft,
  newShareId,
  parseShareAction,
  tryCopyToClipboard,
} from "../engines/share/index.js";
import {
  draftGithubWithClipboard,
  fetchGithubRepo,
  listGithubRepos,
  normalizeRepoKey,
} from "../engines/share/github.js";
import {
  getGlobalShare,
  listGlobalShares,
  markGlobalSharePosted,
  upsertGlobalShare,
} from "../infrastructure/global-shares.js";
import { invokeTool } from "../tools/index.js";
import { runPlanning } from "../capabilities/planning/index.js";
import { runDevelopment } from "../capabilities/development/index.js";
import { runDiagnostic } from "../capabilities/diagnostic/index.js";
import { runReview } from "../capabilities/review/index.js";
import { runSecurityCapability } from "../capabilities/security/index.js";
import { runCycleCapability } from "../capabilities/cycle/index.js";
import {
  addEvidence,
  canTransition,
  createCycleObject,
  LOCK_TTL_MS,
  TERMINAL,
  type Cycle,
} from "./cycle/index.js";
import { guard } from "./orchestrator/index.js";
import { reconcileCycle } from "./state/index.js";
import { fromRow } from "./runtime-helpers.js";
import { writeBriefCache } from "../infrastructure/brief-cache.js";
import { buildAgentBrief } from "../engines/memory/brief.js";
import type { CycleStatus, RiskLevel } from "../shared/contracts.js";

export type CommandOptions = {
  objective?: string;
  approve?: boolean;
  session?: string;
  deep?: boolean;
  commit?: boolean;
  port?: number;
  host?: string;
  remote?: boolean;
  checks?: boolean;
  limit?: number;
  path?: string;
};

function refreshBrief(projectRoot: string, store: Store, cycle: Cycle | null) {
  const brief = buildAgentBrief(projectRoot, store, cycle, cycle?.payload.context ?? null);
  writeBriefCache(projectRoot, brief);
  return brief;
}

function persistBriefFromStore(projectRoot: string, store: Store): void {
  const row = store.activeCycle();
  const cycle = row ? fromRow(row) : null;
  refreshBrief(projectRoot, store, cycle);
}

function persist(store: Store, cycle: Cycle): void {
  store.updateCycle(cycle.id, cycle.status, JSON.stringify(cycle.payload));
  if (TERMINAL.includes(cycle.status)) store.setCurrentCycle(null);
  else store.setCurrentCycle(cycle.id);
}

function conflict(requirement: string, architecture: string, reality: unknown, human?: unknown) {
  return { status: "CONFLICT", requirement, architecture, reality, ...(human ? { human } : {}) };
}

function acquireLock(store: Store, cycleId: string, sessionId: string, projectRoot?: string, cycleMeta?: { status: string; objective: string }) {
  const existing = store.getLock(cycleId);
  const now = Date.now();
  if (existing && Date.parse(existing.expires_at) > now && existing.session_id !== sessionId) {
    return {
      ok: false as const,
      holder: existing.session_id,
      expiresAt: existing.expires_at,
      message: `Cycle locked by session ${existing.session_id} until ${existing.expires_at}. Use the same --session or wait for TTL.`,
    };
  }
  const expiresAt = new Date(now + LOCK_TTL_MS).toISOString();
  store.upsertLock(cycleId, sessionId, nowIso(), expiresAt);
  if (projectRoot && cycleMeta) {
    writeActiveCycleMeta(projectRoot, {
      cycleId,
      status: cycleMeta.status,
      objective: cycleMeta.objective,
      sessionId,
      lockExpiresAt: expiresAt,
    });
  }
  return { ok: true as const, expiresAt };
}

function refreshRisk(cycle: Cycle, command: string, projectRoot: string, git: GitEngine): void {
  const impact = cycle.payload.impact ?? analyzeImpact(projectRoot, cycle.objective, git, git.snapshot());
  const securityHighest = (cycle.payload.security as { highest?: RiskLevel } | undefined)?.highest ?? "LOW";
  const current = assessRisk(cycle.objective, impact, securityHighest);
  cycle.payload.risk = accumulateRisk(cycle.payload.risk, current);
  cycle.payload.riskHistory = [...(cycle.payload.riskHistory ?? []), { at: nowIso(), level: current.level, command }];
}

function transition(cycle: Cycle, to: CycleStatus): boolean {
  if (!canTransition(cycle.status, to)) return false;
  cycle.status = to;
  cycle.updatedAt = nowIso();
  return true;
}

function orchGuard(store: Store, cycle: Cycle, command: string) {
  const gated = guard(cycle.payload.orchestrator, {
    command,
    cycleId: cycle.id,
    extra: { status: cycle.status, head: cycle.payload.gitReconciliation?.current.head ?? null },
  });
  cycle.payload.orchestrator = gated.state;
  if (!gated.ok) {
    transition(cycle, "BLOCKED");
    persist(store, cycle);
    observe(store, "LOOP_OR_BUDGET", { reason: gated.reason }, cycle.id);
    return {
      blocked: {
        status: "BLOCKED",
        reason: gated.reason,
        cycleId: cycle.id,
        message: gated.reason === "loop_detected" ? "Identical command fingerprint repeated 3 times." : gated.reason,
      },
    };
  }
  return { blocked: null };
}

export function handle(command: CommandName, projectRoot: string, options: CommandOptions = {}): unknown {
  if (command === "doctor") {
    const policy = isInitialized(projectRoot) ? loadProjectPolicy(projectRoot) : null;
    return {
      status: "OK",
      identity: IDENTITY,
      runtime: { node: process.version, platform: process.platform, jarvis: JARVIS_VERSION },
      initialized: isInitialized(projectRoot),
      sqlite: isInitialized(projectRoot) ? existsSync(sqlitePath(projectRoot)) : false,
      schemaVersion: LATEST_SCHEMA_VERSION,
      gh: probeGh(),
      policy: policy ? { source: policy.source, risk: policy.risk, git: policy.git } : null,
      briefCache: isInitialized(projectRoot) ? existsSync(briefCachePath(projectRoot)) : false,
      currentPhase: { completed: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21], next: 22 },
    };
  }

  if (command === "init") {
    const result = initHarness(projectRoot);
    const store = Store.open(projectRoot);
    store.close();
    return {
      status: "INITIALIZED",
      created: result.created,
      harness: result.harness,
      config: result.config,
      identity: IDENTITY,
      sqlite: true,
    };
  }

  if (!isInitialized(projectRoot)) {
    if (command === "plan" || command === "context" || command === "status") {
      initHarness(projectRoot);
    } else {
      return { status: "NOT_INITIALIZED", hint: "Run: jarvis init" };
    }
  }

  const store = Store.open(projectRoot);
  try {
    const policy = loadProjectPolicy(projectRoot);
    const sessionId = resolveSessionId(projectRoot, options.session);
    const git = new GitEngine(projectRoot);
    if (command === "status") {
      const active = store.activeCycle();
      const cycle = active ? fromRow(active) : null;
      const lock = active ? store.getLock(active.id) : undefined;
      const lockLive = lock && Date.parse(lock.expires_at) > Date.now();
      const snap = git.snapshot();
      return {
        status: "READY",
        schemaVersion: "jarvis.status.v1",
        projectRoot,
        harnessExists: true,
        sessionId,
        policy: { source: policy.source, risk: policy.risk, git: policy.git, workflow: policy.workflow },
        currentCycle: cycle
          ? {
              id: cycle.id,
              number: cycle.number,
              slug: cycle.slug,
              objective: cycle.objective,
              status: cycle.status,
              riskLevel: cycle.payload.risk?.level ?? null,
              riskAccumulated: cycle.payload.risk?.accumulated ?? null,
            }
          : null,
        lock: lockLive
          ? {
              held: true,
              sessionId: lock.session_id,
              expiresAt: lock.expires_at,
              isThisSession: lock.session_id === sessionId,
            }
          : { held: false },
        git: {
          repository: snap.repository,
          branch: snap.branch ?? null,
          head: snap.head ?? null,
          detachedHead: Boolean(snap.detachedHead),
          workingTreeClean: Boolean(snap.workingTreeClean),
          statusShort: snap.statusShort ?? "",
        },
        identity: IDENTITY,
        jarvisVersion: JARVIS_VERSION,
      };
    }

    if (command === "who") {
      const active = store.activeCycle();
      const lock = active ? store.getLock(active.id) : undefined;
      const lockLive = lock && Date.parse(lock.expires_at) > Date.now();
      return {
        status: "WHO",
        projectRoot,
        sessionId,
        cycleId: active?.id ?? null,
        cycleStatus: active?.status ?? null,
        objective: active?.objective ?? null,
        lock: lockLive
          ? {
              holder: lock.session_id,
              expiresAt: lock.expires_at,
              isThisSession: lock.session_id === sessionId,
              message:
                lock.session_id === sessionId
                  ? "This session holds the Cycle lock."
                  : `Another session holds the lock: ${lock.session_id}`,
            }
          : { holder: null, message: active ? "No live lock (TTL expired or never acquired)." : "No active Cycle." },
      };
    }

    if (command === "export") {
      const active = store.activeCycle();
      if (!active) return { status: "NO_ACTIVE_CYCLE", hint: 'Run: jarvis plan "objective"' };
      const cycle = fromRow(active);
      const result = exportCyclePack(projectRoot, cycle, options.path);
      observe(store, "CYCLE_EXPORTED", { path: result.path, cycleId: cycle.id }, cycle.id);
      return {
        status: "EXPORTED",
        path: result.path,
        cycleId: cycle.id,
        evidenceCount: result.pack.evidence.length,
        checksum: result.pack.checksum,
      };
    }

    if (command === "import") {
      const packPath = options.path ?? options.objective?.trim();
      if (!packPath) {
        return { status: "PATH_REQUIRED", usage: 'jarvis import --path ".harness/exports/cycle-xxx.json"' };
      }
      try {
        const result = importCyclePack(projectRoot, packPath);
        recordMemory(
          store,
          "PROJECT",
          "CYCLE_IMPORT",
          {
            cycleId: result.pack.cycle.id,
            objective: result.pack.cycle.objective,
            status: result.pack.cycle.status,
            importPath: result.importPath,
            checksum: result.pack.checksum,
          },
          "MEDIUM",
          undefined,
          projectRoot,
        );
        observe(store, "CYCLE_IMPORTED", { cycleId: result.pack.cycle.id, importPath: result.importPath });
        return {
          status: "IMPORTED",
          importPath: result.importPath,
          cycle: result.pack.cycle,
          evidenceCount: result.pack.evidence.length,
          note: "Import is read-only evidence. It does not take over the active Cycle lock.",
        };
      } catch (error) {
        return {
          status: "IMPORT_FAILED",
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }

    if (command === "share") {
      const parsed = parseShareAction(options.objective);
      const channel = SHARE_CHANNEL_LINKEDIN;

      if (parsed.action === "github") {
        const listed = listGithubRepos(options.limit ?? 30);
        if (listed.status !== "AVAILABLE") {
          return {
            status: "GITHUB_UNAVAILABLE",
            detail: listed.detail,
            hint: "Instale e autentique o GitHub CLI: gh auth login",
          };
        }
        const shares = listGlobalShares(channel, 200).filter((item) => item.subjectKind === "github");
        const byRepo = new Map(shares.map((item) => [item.subjectKey.toLowerCase(), item]));
        const items = listed.repos.map((repo) => {
          const share = byRepo.get(repo.nameWithOwner.toLowerCase());
          return {
            repo: repo.nameWithOwner,
            description: repo.description,
            url: repo.url,
            updatedAt: repo.updatedAt,
            isPrivate: repo.isPrivate,
            share: share
              ? { status: share.status, draftPath: share.draftPath, postedAt: share.postedAt }
              : { status: "NOT_SHARED" as const },
          };
        });
        const unshared = items.filter((item) => item.share.status === "NOT_SHARED");
        return {
          status: "SHARE_GITHUB_STATUS",
          channel,
          unsharedRepos: unshared.length,
          items,
          unshared: unshared.map((item) => item.repo),
          hint:
            unshared.length > 0
              ? `jarvis share draft ${unshared[0]?.repo}  # rascunho LinkedIn sem precisar de Cycle`
              : "Todos os repos listados já têm share DRAFT/POSTED no registro global (~/.jarvis/shares.json).",
          note: "Usa `gh repo list` da sua conta. Não exige Cycle do JARVIS.",
        };
      }

      if (parsed.action === "status") {
        const completed = store.listCompletedCycles(options.limit ?? 30);
        const shares = store.listShares(100);
        const byCycle = new Map(shares.filter((s) => s.channel === channel).map((s) => [s.cycle_id, s]));
        const items = completed.map((row) => {
          const share = byCycle.get(row.id);
          return {
            cycleId: row.id,
            number: row.number,
            objective: row.objective,
            status: row.status,
            share: share
              ? { status: share.status, draftPath: share.draft_path, postedAt: share.posted_at }
              : { status: "NOT_SHARED" as const },
          };
        });
        const unshared = items.filter((item) => item.share.status === "NOT_SHARED").length;
        return {
          status: "SHARE_STATUS",
          channel,
          unsharedCompleted: unshared,
          items,
          hint: unshared
            ? 'jarvis share draft  # último Cycle COMPLETED'
            : "Nenhum Cycle COMPLETED pendente. Para repos do GitHub: jarvis share github",
        };
      }

      if (parsed.action === "done") {
        if (parsed.repoKey) {
          const repoKey = normalizeRepoKey(parsed.repoKey);
          if (!repoKey) {
            return { status: "INVALID_REPO", usage: "jarvis share done owner/repo" };
          }
          const marked = markGlobalSharePosted("github", repoKey, channel);
          if (!marked) {
            return {
              status: "NO_DRAFT",
              repo: repoKey,
              hint: `jarvis share draft ${repoKey}`,
            };
          }
          observe(store, "SHARE_POSTED", { subjectKind: "github", subjectKey: repoKey, channel });
          return {
            status: "SHARE_MARKED_POSTED",
            subjectKind: "github",
            repo: repoKey,
            channel,
            postedAt: marked.postedAt,
            message: "Registrado em ~/.jarvis/shares.json. JARVIS não publica no LinkedIn por você.",
          };
        }

        let cycleId = parsed.cycleId;
        if (!cycleId) {
          const latest = store.listShares(1).find((s) => s.channel === channel && s.status === "DRAFT");
          cycleId = latest?.cycle_id;
        }
        if (!cycleId) {
          return {
            status: "CYCLE_REQUIRED",
            usage: "jarvis share done <cycleId|owner/repo>",
            hint: "Gere um draft antes: jarvis share draft  |  jarvis share draft owner/repo",
          };
        }
        const existing = store.getShare(cycleId, channel);
        if (!existing) {
          return { status: "NO_DRAFT", cycleId, hint: "jarvis share draft " + cycleId };
        }
        const postedAt = nowIso();
        store.markSharePosted(cycleId, channel, postedAt);
        observe(store, "SHARE_POSTED", { cycleId, channel }, cycleId);
        recordMemory(
          store,
          "PROJECT",
          "SHARE_POSTED",
          { cycleId, channel, postedAt },
          "MEDIUM",
          cycleId,
          projectRoot,
        );
        return {
          status: "SHARE_MARKED_POSTED",
          subjectKind: "cycle",
          cycleId,
          channel,
          postedAt,
          message: "Registrado localmente. JARVIS não publica no LinkedIn por você.",
        };
      }

      // draft — GitHub repo (sem Cycle)
      if (parsed.repoKey) {
        const repoKey = normalizeRepoKey(parsed.repoKey);
        if (!repoKey) {
          return { status: "INVALID_REPO", usage: "jarvis share draft owner/repo" };
        }
        const fetched = fetchGithubRepo(repoKey);
        if (fetched.status !== "AVAILABLE" || !fetched.repo) {
          return {
            status: "GITHUB_UNAVAILABLE",
            repo: repoKey,
            detail: fetched.detail,
            hint: "Confira `gh auth status` e se o repo existe na sua conta.",
          };
        }
        const draft = draftGithubWithClipboard(
          fetched.repo,
          options.path ? { path: options.path } : undefined,
        );
        const existing = getGlobalShare("github", draft.repoKey, channel);
        upsertGlobalShare({
          subjectKind: "github",
          subjectKey: draft.repoKey,
          channel,
          status: existing?.status === "POSTED" ? "POSTED" : "DRAFT",
          draftPath: draft.path,
          draftText: draft.text,
          postedAt: existing?.postedAt ?? null,
          meta: { repoUrl: draft.repoUrl, projectName: draft.projectName },
        });
        observe(store, "SHARE_DRAFT", {
          subjectKind: "github",
          subjectKey: draft.repoKey,
          path: draft.path,
          clipboard: draft.clipboard.copied,
        });
        return {
          status: "SHARE_DRAFT",
          subjectKind: "github",
          channel,
          repo: draft.repoKey,
          path: draft.path,
          text: draft.text,
          repoUrl: draft.repoUrl,
          clipboard: draft.clipboard,
          next: [
            "Revise o texto (arquivo ou clipboard).",
            "Publique manualmente no LinkedIn.",
            `Depois: jarvis share done ${draft.repoKey}`,
          ],
          note: "Draft a partir do GitHub via `gh` — não precisa de Cycle do JARVIS.",
        };
      }

      // draft — Cycle COMPLETED
      let row = parsed.cycleId ? store.getCycle(parsed.cycleId) : undefined;
      if (!row) {
        const completed = store.listCompletedCycles(1)[0];
        row = completed;
      }
      if (!row) {
        return {
          status: "NO_COMPLETED_CYCLE",
          hint: "Feche um Cycle com `jarvis feche`, ou use um repo: jarvis share draft owner/repo  |  jarvis share github",
        };
      }
      if (row.status !== "COMPLETED") {
        return {
          status: "CYCLE_NOT_COMPLETED",
          cycleId: row.id,
          cycleStatus: row.status,
          hint: "Share draft de Cycle usa só COMPLETED. Para GitHub sem Cycle: jarvis share draft owner/repo",
        };
      }
      const cycle = fromRow(row);
      const draft = createLinkedInDraft(projectRoot, cycle, git, options.path ? { path: options.path } : undefined);
      const existing = store.getShare(cycle.id, channel);
      store.upsertShare({
        id: existing?.id ?? newShareId(),
        project_id: store.projectId,
        cycle_id: cycle.id,
        channel,
        status: existing?.status === "POSTED" ? "POSTED" : "DRAFT",
        draft_path: draft.path,
        draft_text: draft.text,
        posted_at: existing?.posted_at ?? null,
        created_at: existing?.created_at ?? nowIso(),
      });
      if (draft.repoUrl) {
        const repoKey = normalizeRepoKey(draft.repoUrl);
        if (repoKey) {
          const gExisting = getGlobalShare("github", repoKey, channel);
          upsertGlobalShare({
            subjectKind: "github",
            subjectKey: repoKey,
            channel,
            status: gExisting?.status === "POSTED" ? "POSTED" : "DRAFT",
            draftPath: draft.path,
            draftText: draft.text,
            postedAt: gExisting?.postedAt ?? null,
            meta: { repoUrl: draft.repoUrl, projectName: draft.projectName },
          });
        }
      }
      const clipboard = tryCopyToClipboard(draft.text);
      observe(store, "SHARE_DRAFT", { cycleId: cycle.id, path: draft.path, clipboard: clipboard.ok }, cycle.id);
      return {
        status: "SHARE_DRAFT",
        subjectKind: "cycle",
        channel,
        cycleId: cycle.id,
        path: draft.path,
        text: draft.text,
        repoUrl: draft.repoUrl,
        clipboard: clipboard.ok
          ? { copied: true }
          : { copied: false, detail: clipboard.detail },
        next: [
          "Revise o texto no arquivo (ou cole do clipboard).",
          "Publique manualmente no LinkedIn (perfil pessoal).",
          `Depois: jarvis share done ${cycle.id}`,
        ],
        note: "Sem autopost. API LinkedIn pessoal não é usada de propósito.",
      };
    }

    if (command === "context") {
      return discoverContext(projectRoot, options.deep === true);
    }

    if (command === "logs") {
      const active = store.activeCycle();
      return buildTimeline(store, { ...(active?.id ? { cycleId: active.id } : {}), limit: options.limit ?? 50 });
    }

    if (command === "reconcile") {
      const active = store.activeCycle();
      const baseline = active ? fromRow(active).payload.gitBaseline : undefined;
      const reconciliation = git.reconcile(baseline, {
        remote: policy.git.remote,
        fetch: options.remote ?? policy.git.fetchOnReconcile,
      });
      if (active) {
        const cycle = reconcileCycle(store, fromRow(active));
        cycle.payload.gitReconciliation = reconciliation;
        persist(store, cycle);
        observe(store, "GIT_RECONCILE", { changes: reconciliation.changes, remote: reconciliation.remote }, cycle.id);
      }
      return {
        status: "RECONCILED",
        policySource: policy.source,
        reconciliation,
        cycleId: active?.id ?? null,
      };
    }

    if (command === "brief") {
      const active = store.activeCycle();
      const cycle = active ? reconcileCycle(store, fromRow(active)) : null;
      const brief = refreshBrief(projectRoot, store, cycle);
      return { status: "BRIEF", brief };
    }

    if (command === "memorize") {
      const note = options.objective?.trim();
      if (!note) {
        return { status: "NOTE_REQUIRED", usage: 'jarvis memorize "stack usa pnpm e vitest"' };
      }
      const active = store.activeCycle();
      recordMemory(store, "PROJECT", "HOST_NOTE", { text: note }, "MEDIUM", active?.id, projectRoot);
      const brief = refreshBrief(projectRoot, store, active ? fromRow(active) : null);
      return { status: "RECORDED", kind: "HOST_NOTE", brief };
    }

    if (command === "plan") {
      if (!options.objective) {
        return {
          status: "OBJECTIVE_REQUIRED",
          usage: 'jarvis plan "your objective" --project "C:\\path\\to\\project"',
        };
      }
      const existing = store.activeCycle();
      if (existing) return { status: "CYCLE_ALREADY_ACTIVE", cycle: fromRow(existing) };

      return store.transaction(() => {
        const cycle = createCycleObject(options.objective!, store.nextCycleNumber());
        const snapshot = git.snapshot();
        cycle.payload.gitBaseline = snapshot;
        cycle.payload.branch = git.ensureCycleBranch(cycle.slug, cycle.number, snapshot);
        const context = discoverContext(projectRoot, true);
        cycle.payload.context = context;
        addEvidence(cycle, "STRUCTURAL_DISCOVERY", context, "context-engine");
        const l2Surface = "l2Surface" in context ? context.l2Surface : undefined;
        const impact = analyzeImpact(projectRoot, cycle.objective, git, snapshot, l2Surface);
        cycle.payload.impact = impact;
        addEvidence(cycle, "IMPACT_ANALYSIS", impact, "impact-engine", "INFERRED", impact.confidence);
        const security = scanSecurity(projectRoot, cycle.objective, git);
        cycle.payload.security = security;
        addEvidence(cycle, "SECURITY_SCAN", security, "security-engine");
        const risk = assessRisk(cycle.objective, impact, security.highest);
        cycle.payload.risk = risk;
        cycle.payload.riskHistory = [{ at: nowIso(), level: risk.level, command: "plan" }];
        addEvidence(cycle, "RISK_ASSESSMENT", risk, "risk-engine");
        recordMemory(
          store,
          "PROJECT",
          "STACK",
          { ecosystems: context.levels.L0.ecosystems },
          "HIGH",
          cycle.id,
          projectRoot,
        );
        recordMemory(
          store,
          "PROJECT",
          "TOP_LEVEL",
          { dirs: (context.levels.L1.topLevel as string[] | undefined)?.slice(0, 24) ?? [] },
          "MEDIUM",
          cycle.id,
          projectRoot,
        );
        const memory = recallMemory(store, projectRoot);
        cycle.payload.memory = memory;
        addEvidence(cycle, "MEMORY_RECALL", memory, "memory-engine", memory.status === "EMPTY" ? "UNKNOWN" : "KNOWN", "LOW");
        cycle.payload.gitReconciliation = git.reconcile(snapshot);
        cycle.payload.contract = buildContract(cycle.objective, cycle.number);
        addEvidence(cycle, "CONTRACT", cycle.payload.contract, "contract-engine");
        runPlanning(cycle);
        cycle.status = risk.level === "CRITICAL" ? "BLOCKED" : "READY";
        store.insertCycle({
          id: cycle.id,
          uuid: cycle.uuid,
          number: cycle.number,
          slug: cycle.slug,
          project_id: store.projectId,
          objective: cycle.objective,
          status: cycle.status,
          payload: JSON.stringify(cycle.payload),
          created_at: cycle.createdAt,
          updated_at: cycle.updatedAt,
        });
        store.setCurrentCycle(cycle.id);
        acquireLock(store, cycle.id, sessionId, projectRoot, { status: cycle.status, objective: cycle.objective });
        observe(store, "CYCLE_CREATED", { objective: cycle.objective }, cycle.id);
        store.addCheckpoint(shortId("cp"), cycle.id, "STRATEGIC", cycle);
        return {
          status: "PLANNING",
          cycleId: cycle.id,
          cycleStatus: cycle.status,
          objective: cycle.objective,
          identity: IDENTITY,
          context,
          contract: cycle.payload.contract,
          gitBaseline: snapshot,
          gitReconciliation: cycle.payload.gitReconciliation,
          branch: cycle.payload.branch,
          impact,
          risk,
          security,
          memory,
          brief: refreshBrief(projectRoot, store, cycle),
          next: risk.level === "HIGH" ? "DECISION_REQUIRED" : "DEV_READY",
          message: "Planning foundation created. No implementation was executed.",
        };
      });
    }

    const row = store.activeCycle();
    if (!row) return { status: "NO_ACTIVE_CYCLE", hint: 'Run: jarvis plan "objective"' };
    const cycle = reconcileCycle(store, fromRow(row));
    const locked = acquireLock(store, cycle.id, sessionId, projectRoot, {
      status: cycle.status,
      objective: cycle.objective,
    });
    if (!locked.ok) {
      return conflict(
        "control the open Cycle",
        "Only one session may control an open Cycle",
        { holder: locked.holder, sessionId, expiresAt: locked.expiresAt, message: locked.message },
      );
    }

    const guarded = orchGuard(store, cycle, command);
    if (guarded.blocked) return guarded.blocked;

    if (command === "dev") {
      cycle.payload.gitReconciliation = git.reconcile(cycle.payload.gitBaseline, {
        remote: policy.git.remote,
        fetch: policy.git.fetchOnReconcile,
      });
      addEvidence(cycle, "GIT_RECONCILIATION", cycle.payload.gitReconciliation, "git-engine");
      const humanPaths = (cycle.payload.impact?.layers.HUMAN ?? []).map((item: { path: string }) => item.path);
      const approved = Boolean(options.approve) || cycle.payload.approvals.length > 0;
      const permission = decidePermission(cycle.payload.risk?.level ?? "LOW", approved, policy.risk);
      if (options.approve && permission.decision === "ALLOW" && cycle.payload.risk?.level === "HIGH") {
        cycle.payload.approvals.push({ at: nowIso(), command: "dev" });
        store.addApproval(shortId("apq"), cycle.id, "dev");
      }
      const developed = runDevelopment(cycle, permission, humanPaths);
      cycle.payload.execution = developed.output;
      addEvidence(cycle, "EXECUTION_GATE", developed.output, "development-capability");
      observe(store, "ACTION_STARTED", { command: "dev" }, cycle.id);
      if (developed.output.status === "BLOCKED") transition(cycle, "BLOCKED");
      else if (developed.output.status === "REQUIRES_APPROVAL") {
        persist(store, cycle);
        return { ...developed.output, cycleId: cycle.id, cycleStatus: cycle.status };
      } else {
        transition(cycle, "EXECUTING");
        observe(store, "ACTION_FINISHED", { command: "dev" }, cycle.id);
      }
      persist(store, cycle);
      store.addCheckpoint(shortId("cp"), cycle.id, "OPERATIONAL", { execution: developed.output });
      return { ...developed.output, cycleId: cycle.id, cycleStatus: cycle.status };
    }

    if (command === "test") {
      const result = runTests(projectRoot, cycle.payload.context, cycle.payload.impact);
      cycle.payload.test = result;
      addEvidence(cycle, "TEST_RUN", result, "test-engine", result.ran ? "KNOWN" : "UNKNOWN", result.ran ? "HIGH" : "LOW");
      refreshRisk(cycle, "test", projectRoot, git);
      if (cycle.payload.contract) {
        const ac1 = cycle.payload.contract.acceptanceCriteria.find((item: { id: string }) => item.id === "AC-1");
        if (ac1 && result.ran) ac1.status = result.status === "PASSED" ? "PASS" : "FAIL";
      }
      transition(cycle, "TESTING");
      persist(store, cycle);
      observe(store, "TEST_RUN", { status: result.status }, cycle.id);
      return { ...result, cycleId: cycle.id, cycleStatus: cycle.status };
    }

    if (command === "review") {
      const reviewed = runReview(cycle);
      cycle.payload.review = reviewed.output;
      addEvidence(cycle, "REVIEW", reviewed.output, "review-capability");
      runDiagnostic(cycle);
      transition(cycle, "REVIEWING");
      persist(store, cycle);
      return { ...reviewed.output, cycleId: cycle.id, cycleStatus: cycle.status };
    }

    if (command === "security") {
      const scan = scanSecurity(projectRoot, cycle.objective, git);
      cycle.payload.security = scan;
      const impact = cycle.payload.impact ?? analyzeImpact(projectRoot, cycle.objective, git, git.snapshot());
      cycle.payload.impact = impact;
      refreshRisk(cycle, "security", projectRoot, git);
      addEvidence(cycle, "SECURITY_SCAN", scan, "security-engine");
      runSecurityCapability(cycle);
      transition(cycle, "SECURITY");
      persist(store, cycle);
      return { ...scan, risk: cycle.payload.risk, cycleId: cycle.id, cycleStatus: cycle.status };
    }

    if (command === "pause") {
      if (cycle.status === "PAUSED") {
        return { status: "ALREADY_PAUSED", cycleId: cycle.id, cycleStatus: cycle.status };
      }
      if (TERMINAL.includes(cycle.status)) {
        return { status: "CYCLE_TERMINAL", cycleId: cycle.id, cycleStatus: cycle.status };
      }
      cycle.payload.pausedFrom = cycle.status;
      transition(cycle, "PAUSED");
      persist(store, cycle);
      observe(store, "CYCLE_PAUSED", { from: cycle.payload.pausedFrom }, cycle.id);
      return { status: "PAUSED", cycleId: cycle.id, cycleStatus: cycle.status, pausedFrom: cycle.payload.pausedFrom };
    }

    if (command === "resume") {
      if (cycle.status !== "PAUSED") {
        return { status: "NOT_PAUSED", cycleId: cycle.id, cycleStatus: cycle.status };
      }
      const target = cycle.payload.pausedFrom ?? "READY";
      if (!transition(cycle, target)) transition(cycle, "READY");
      delete cycle.payload.pausedFrom;
      persist(store, cycle);
      observe(store, "CYCLE_RESUMED", { to: cycle.status }, cycle.id);
      return { status: "RESUMED", cycleId: cycle.id, cycleStatus: cycle.status };
    }

    if (command === "wait") {
      const reason = options.objective?.trim() || "external dependency (PR/CI/manual gate)";
      cycle.payload.waitReason = reason;
      let checksReport = null;
      if (options.checks) {
        checksReport = fetchChecks(projectRoot);
        addEvidence(cycle, "CI_CHECKS", checksReport, "gh-cli", checksReport.status === "AVAILABLE" ? "KNOWN" : "UNKNOWN");
        if (checksReport.status === "AVAILABLE" && checksReport.allPassed) {
          transition(cycle, "REVIEWING");
          persist(store, cycle);
          observe(store, "CI_CHECKS_PASSED", { count: checksReport.checks.length }, cycle.id);
          return {
            status: "CHECKS_PASSED",
            cycleId: cycle.id,
            cycleStatus: cycle.status,
            checks: checksReport,
            reason,
          };
        }
      }
      transition(cycle, "WAITING_EXTERNAL");
      persist(store, cycle);
      observe(store, "CYCLE_WAITING", { reason, checks: checksReport?.status ?? "skipped" }, cycle.id);
      return {
        status: "WAITING_EXTERNAL",
        cycleId: cycle.id,
        cycleStatus: cycle.status,
        reason,
        ...(checksReport ? { checks: checksReport } : {}),
      };
    }

    if (command === "close") {
      if (policy.workflow.requireTestBeforeClose) {
        const testResult = cycle.payload.test as { status?: string; ran?: boolean } | undefined;
        if (!testResult?.ran || testResult.status !== "PASSED") {
          return {
            status: "BLOCKED",
            reason: "Project policy requires a passing test run before close.",
            cycleId: cycle.id,
            policy: policy.source,
          };
        }
      }
      runCycleCapability(cycle.payload.execution ? "close" : "abandon");
      if (cycle.payload.risk?.level === "CRITICAL") {
        transition(cycle, "BLOCKED");
        persist(store, cycle);
        return { status: "BLOCKED", reason: "CRITICAL cycles cannot be closed as completed.", cycleId: cycle.id };
      }
      if (cycle.payload.contract) {
        const ac2 = cycle.payload.contract.acceptanceCriteria.find((item: { id: string }) => item.id === "AC-2");
        if (ac2) ac2.status = "PASS";
      }
      const status = cycle.payload.execution ? "COMPLETED" : "ABANDONED";
      if (!transition(cycle, status)) cycle.status = status;
      recordMemory(store, "CYCLE", "CYCLE_CLOSED", { objective: cycle.objective, status }, "MEDIUM", cycle.id);
      recordMemory(store, "PROJECT", "LAST_CYCLE", { cycleId: cycle.id, status }, "MEDIUM", cycle.id);
      if (status === "COMPLETED") {
        promoteToGlobal(store, "LAST_COMPLETED_CYCLE", { cycleId: cycle.id, objective: cycle.objective }, "MEDIUM", {
          projectRoot,
          cycleId: cycle.id,
        });
      }
      if (options.commit) {
        const tool = invokeTool("git.commit", ["git", "commit"], "HIGH", Boolean(options.approve));
        if (tool.status !== "ALLOW") {
          persist(store, cycle);
          store.deleteLock(cycle.id);
          return { status: cycle.status, cycleId: cycle.id, commit: tool };
        }
        const committed = git.commit(`jarvis(${cycle.slug}): close cycle ${cycle.number}`);
        persist(store, cycle);
        store.deleteLock(cycle.id);
        return { status: cycle.status, cycleId: cycle.id, commit: committed, memory: true };
      }
      persist(store, cycle);
      store.deleteLock(cycle.id);
      observe(store, "CYCLE_CLOSED", { status: cycle.status }, cycle.id);
      return {
        status: cycle.status,
        cycleId: cycle.id,
        message: "Cycle closed. current_cycle was cleared.",
        ...(status === "COMPLETED"
          ? {
              next: {
                share: `jarvis share draft`,
                hint: "Gera rascunho LinkedIn (perfil pessoal) a partir deste Cycle — sem autopost.",
              },
            }
          : {}),
      };
    }

    return { status: "UNKNOWN_COMMAND", command };
  } finally {
    if (isInitialized(projectRoot)) {
      try {
        persistBriefFromStore(projectRoot, store);
      } catch {
        /* brief cache is best-effort */
      }
    }
    store.close();
  }
}
