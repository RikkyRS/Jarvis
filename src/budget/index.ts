import type { DatabaseSync } from "node:sqlite";
import type { BudgetPhase, Principal } from "../domain/contracts.js";
import { newId } from "../domain/ids.js";
import { AuditLog } from "../persistence/audit.js";
import { inTransaction } from "../persistence/db.js";
import { DomainError, DomainStore } from "../persistence/repositories.js";
import { systemClock, type Clock } from "../shared/clock.js";

export type BudgetConfig = {
  /** Default 0.75. May be made more conservative, never above the hard stop. */
  warnRatio: number;
  /** Default 0.90. */
  restrictRatio: number;
  /** Fraction of the already-authorized allowance kept for critical work. Not extra budget. */
  reserveRatio: number;
};

export const DEFAULT_BUDGET_CONFIG: BudgetConfig = {
  warnRatio: 0.75,
  restrictRatio: 0.9,
  reserveRatio: 0,
};

export type BudgetLevel = "NONE" | "NORMAL" | "WARNING" | "RESTRICTED" | "EXHAUSTED";

export type BudgetStatus = {
  missionId: string;
  phase: BudgetPhase;
  allowance: number;
  used: number;
  reserved: number;
  remaining: number;
  criticalReserve: number;
  level: BudgetLevel;
};

export type ReserveRequest = {
  missionId: string;
  phase: BudgetPhase;
  estimate: number;
  /** Critical work may use the protected reserve. */
  critical?: boolean;
  /** Non-essential calls are suspended at the restriction threshold. */
  essential?: boolean;
};

export type ReserveResult =
  | { ok: true; reservationId: string; status: BudgetStatus }
  | {
      ok: false;
      reason: "NO_ALLOWANCE" | "EXHAUSTED" | "RESTRICTED" | "INSUFFICIENT";
      status: BudgetStatus;
    };

export type UsageReport =
  | { state: "ACTUAL"; inputTokens: number; outputTokens: number; cachedInputTokens?: number }
  | { state: "ESTIMATED" | "UNAVAILABLE" };

export type UsageAttribution = {
  agent: string;
  provider: string;
  model: string;
  workItemId?: string;
  workflowRunId?: string;
  operationId?: string;
};

export type GrantInput = {
  missionId: string;
  phase: BudgetPhase;
  amount: number;
  actor: Principal;
  reason: string;
  kind?: "INITIAL" | "ADDITIONAL";
};

type Row = Record<string, unknown>;

/**
 * Per-Mission token governance. Preparation and Execution are separate balances that
 * cannot be transferred. The runtime never grants itself tokens: every grant is an
 * immutable ledger entry authorized by the Mission owner, or by an administrator that
 * holds BOTH the project permission and an explicit delegation from the owner.
 */
export class MissionBudget {
  constructor(
    private readonly db: DatabaseSync,
    private readonly audit: AuditLog,
    private readonly store: DomainStore,
    private readonly config: BudgetConfig = DEFAULT_BUDGET_CONFIG,
    private readonly clock: Clock = systemClock,
  ) {
    if (!(config.warnRatio < config.restrictRatio && config.restrictRatio <= 1)) {
      throw new DomainError(
        "Budget thresholds must satisfy warn < restrict <= 1 (the hard stop is fixed at 100%).",
      );
    }
    if (config.reserveRatio < 0 || config.reserveRatio >= 1)
      throw new DomainError("Invalid reserve ratio.");
  }

  // --- missions & authority --------------------------------------------------

  createMission(input: { projectId: string; owner: Principal; workItemId?: string }): string {
    if (input.owner.kind !== "human") throw new DomainError("Only a human can own a mission.");
    if (!this.store.getProject(input.projectId)) throw new DomainError("Unknown project.");
    const id = newId("mis");
    inTransaction(this.db, () => {
      this.db
        .prepare(
          "INSERT INTO missions (id, project_id, work_item_id, owner_id, scope_version, created_at) VALUES (?, ?, ?, ?, 1, ?)",
        )
        .run(
          id,
          input.projectId,
          input.workItemId ?? null,
          input.owner.id,
          this.clock().toISOString(),
        );
      this.audit.append({
        projectId: input.projectId,
        kind: "mission.created",
        actor: input.owner,
        subject: id,
      });
    });
    return id;
  }

  private mission(id: string): {
    id: string;
    project_id: string;
    owner_id: string;
    scope_version: number;
  } {
    const m = this.db.prepare("SELECT * FROM missions WHERE id = ?").get(id) as
      { id: string; project_id: string; owner_id: string; scope_version: number } | undefined;
    if (!m) throw new DomainError(`Unknown mission ${id}.`);
    return m;
  }

  /** Only the owner delegates; an administrator can never delegate to themselves. */
  delegate(missionId: string, owner: Principal, adminId: string, expiresAt?: string): string {
    const m = this.mission(missionId);
    if (owner.kind !== "human" || owner.id !== m.owner_id)
      throw new DomainError("Only the mission owner can delegate.");
    if (adminId === owner.id)
      throw new DomainError("Delegation target must be a different principal.");
    const id = newId("dlg");
    inTransaction(this.db, () => {
      this.db
        .prepare(
          "INSERT INTO mission_delegations (id, mission_id, admin_id, delegated_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(id, missionId, adminId, owner.id, this.clock().toISOString(), expiresAt ?? null);
      this.audit.append({
        projectId: m.project_id,
        kind: "mission.delegation_created",
        actor: owner,
        subject: id,
        payload: { missionId, adminId, expiresAt: expiresAt ?? null },
      });
    });
    return id;
  }

  revokeDelegation(delegationId: string, owner: Principal): void {
    const d = this.db
      .prepare("SELECT * FROM mission_delegations WHERE id = ?")
      .get(delegationId) as Row | undefined;
    if (!d) throw new DomainError("Unknown delegation.");
    const m = this.mission(String(d.mission_id));
    if (owner.kind !== "human" || owner.id !== m.owner_id)
      throw new DomainError("Only the mission owner can revoke.");
    inTransaction(this.db, () => {
      this.db
        .prepare(
          "UPDATE mission_delegations SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
        )
        .run(this.clock().toISOString(), delegationId);
      this.audit.append({
        projectId: m.project_id,
        kind: "mission.delegation_revoked",
        actor: owner,
        subject: delegationId,
      });
    });
  }

  /** Checked at grant time, every time. Returns the recorded basis or throws. */
  private authorizeGrant(missionId: string, actor: Principal): "OWNER" | "ADMIN_DELEGATED" {
    const m = this.mission(missionId);
    if (actor.kind !== "human") throw new DomainError("Only a human can authorize token grants.");
    if (actor.id === m.owner_id) return "OWNER";
    const permitted = this.store.permissionsOf(m.project_id, actor.id).includes("mission.grant");
    const now = this.clock().toISOString();
    const delegation = this.db
      .prepare(
        `SELECT id FROM mission_delegations
         WHERE mission_id = ? AND admin_id = ? AND delegated_by = ? AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .get(missionId, actor.id, m.owner_id, now);
    if (permitted && delegation) return "ADMIN_DELEGATED";
    throw new DomainError(
      "Grant requires the owner, or an admin with mission.grant permission AND an owner delegation.",
    );
  }

  grant(input: GrantInput): string {
    if (!Number.isInteger(input.amount) || input.amount <= 0)
      throw new DomainError("Grant amount must be a positive integer.");
    const m = this.mission(input.missionId);
    const basis = this.authorizeGrant(input.missionId, input.actor);
    const existing = this.db
      .prepare("SELECT COUNT(*) AS n FROM token_grants WHERE mission_id = ? AND phase = ?")
      .get(input.missionId, input.phase) as { n: number };
    const kind = input.kind ?? (existing.n === 0 ? "INITIAL" : "ADDITIONAL");
    if (kind === "INITIAL" && existing.n > 0)
      throw new DomainError("Initial grant already exists for this phase.");
    if (kind === "ADDITIONAL" && existing.n === 0)
      throw new DomainError("Additional grant requires an initial grant.");
    if (kind === "INITIAL" && basis !== "OWNER")
      throw new DomainError("Only the owner can make the initial grant.");
    const id = newId("grt");
    inTransaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO token_grants (id, mission_id, phase, kind, amount, authorized_by, authorization_basis, scope_version, reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.missionId,
          input.phase,
          kind,
          input.amount,
          input.actor.id,
          basis,
          m.scope_version,
          input.reason,
          this.clock().toISOString(),
        );
      this.audit.append({
        projectId: m.project_id,
        kind: "mission.token_grant",
        actor: input.actor,
        subject: id,
        payload: {
          missionId: input.missionId,
          phase: input.phase,
          kind,
          amount: input.amount,
          basis,
          reason: input.reason,
        },
      });
    });
    return id;
  }

  // --- accounting --------------------------------------------------------------

  status(missionId: string, phase: BudgetPhase): BudgetStatus {
    const allowance = (
      this.db
        .prepare(
          "SELECT COALESCE(SUM(amount), 0) AS n FROM token_grants WHERE mission_id = ? AND phase = ?",
        )
        .get(missionId, phase) as { n: number }
    ).n;
    // Effective usage: a record superseded by a reconciliation is excluded, never deleted.
    const used = (
      this.db
        .prepare(
          `SELECT COALESCE(SUM(u.charged_tokens), 0) AS n FROM token_usage u
           WHERE u.mission_id = ? AND u.phase = ?
             AND NOT EXISTS (SELECT 1 FROM token_usage r WHERE r.reconciles = u.id)`,
        )
        .get(missionId, phase) as { n: number }
    ).n;
    const reserved = (
      this.db
        .prepare(
          "SELECT COALESCE(SUM(amount), 0) AS n FROM token_reservations WHERE mission_id = ? AND phase = ? AND status = 'RESERVED'",
        )
        .get(missionId, phase) as { n: number }
    ).n;
    const committed = used + reserved;
    let level: BudgetLevel = "NORMAL";
    if (allowance === 0) level = "NONE";
    else if (committed >= allowance) level = "EXHAUSTED";
    else if (committed >= allowance * this.config.restrictRatio) level = "RESTRICTED";
    else if (committed >= allowance * this.config.warnRatio) level = "WARNING";
    return {
      missionId,
      phase,
      allowance,
      used,
      reserved,
      remaining: allowance - committed,
      criticalReserve: Math.floor(allowance * this.config.reserveRatio),
      level,
    };
  }

  /** Atomic: concurrent callers cannot overspend the authorized allowance. */
  reserve(request: ReserveRequest): ReserveResult {
    if (!Number.isInteger(request.estimate) || request.estimate < 0)
      throw new DomainError("Estimate must be a non-negative integer.");
    this.mission(request.missionId);
    return inTransaction(this.db, () => {
      const status = this.status(request.missionId, request.phase);
      const deny = (reason: Extract<ReserveResult, { ok: false }>["reason"]): ReserveResult => ({
        ok: false,
        reason,
        status,
      });
      if (status.level === "NONE") return deny("NO_ALLOWANCE");
      if (status.level === "EXHAUSTED") return deny("EXHAUSTED");
      if (status.level === "RESTRICTED" && !request.critical && request.essential === false)
        return deny("RESTRICTED");
      const available = request.critical
        ? status.remaining
        : status.remaining - status.criticalReserve;
      if (request.estimate > available) return deny("INSUFFICIENT");
      const id = newId("rsv");
      this.db
        .prepare(
          "INSERT INTO token_reservations (id, mission_id, phase, amount, critical, status, created_at) VALUES (?, ?, ?, ?, ?, 'RESERVED', ?)",
        )
        .run(
          id,
          request.missionId,
          request.phase,
          request.estimate,
          request.critical ? 1 : 0,
          this.clock().toISOString(),
        );
      return { ok: true, reservationId: id, status: this.status(request.missionId, request.phase) };
    });
  }

  release(reservationId: string): void {
    this.db
      .prepare(
        "UPDATE token_reservations SET status = 'RELEASED' WHERE id = ? AND status = 'RESERVED'",
      )
      .run(reservationId);
  }

  /**
   * Records what a call actually cost. A call already in flight at the limit is always
   * settled, so the ledger stays truthful; an estimate is never presented as actual.
   * Cached input is stored separately and not charged twice.
   */
  settle(reservationId: string, usage: UsageReport, who: UsageAttribution): string {
    return inTransaction(this.db, () => {
      const r = this.db
        .prepare("SELECT * FROM token_reservations WHERE id = ?")
        .get(reservationId) as Row | undefined;
      if (!r || r.status !== "RESERVED") throw new DomainError("Reservation is not open.");
      const charged =
        usage.state === "ACTUAL" ? usage.inputTokens + usage.outputTokens : Number(r.amount);
      const id = newId("use");
      this.db
        .prepare(
          `INSERT INTO token_usage (id, mission_id, phase, work_item_id, workflow_run_id, operation_id, agent, provider, model,
             state, input_tokens, output_tokens, cached_input_tokens, estimated_tokens, charged_tokens, reservation_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          r.mission_id as string,
          r.phase as string,
          who.workItemId ?? null,
          who.workflowRunId ?? null,
          who.operationId ?? null,
          who.agent,
          who.provider,
          who.model,
          usage.state,
          usage.state === "ACTUAL" ? usage.inputTokens : null,
          usage.state === "ACTUAL" ? usage.outputTokens : null,
          usage.state === "ACTUAL" ? (usage.cachedInputTokens ?? 0) : null,
          Number(r.amount),
          charged,
          reservationId,
          this.clock().toISOString(),
        );
      this.db
        .prepare("UPDATE token_reservations SET status = 'SETTLED' WHERE id = ?")
        .run(reservationId);
      return id;
    });
  }

  /** A late provider report supersedes the earlier record without erasing it. */
  reconcile(
    usageId: string,
    actual: { inputTokens: number; outputTokens: number; cachedInputTokens?: number },
  ): string {
    return inTransaction(this.db, () => {
      const u = this.db.prepare("SELECT * FROM token_usage WHERE id = ?").get(usageId) as
        Row | undefined;
      if (!u) throw new DomainError("Unknown usage record.");
      if (this.db.prepare("SELECT 1 FROM token_usage WHERE reconciles = ?").get(usageId)) {
        throw new DomainError("Usage record was already reconciled.");
      }
      const id = newId("use");
      this.db
        .prepare(
          `INSERT INTO token_usage (id, mission_id, phase, work_item_id, workflow_run_id, operation_id, agent, provider, model,
             state, input_tokens, output_tokens, cached_input_tokens, estimated_tokens, charged_tokens, reservation_id, reconciles, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTUAL', ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          u.mission_id as string,
          u.phase as string,
          (u.work_item_id as string | null) ?? null,
          (u.workflow_run_id as string | null) ?? null,
          (u.operation_id as string | null) ?? null,
          u.agent as string,
          u.provider as string,
          u.model as string,
          actual.inputTokens,
          actual.outputTokens,
          actual.cachedInputTokens ?? 0,
          (u.estimated_tokens as number | null) ?? null,
          actual.inputTokens + actual.outputTokens,
          (u.reservation_id as string | null) ?? null,
          usageId,
          this.clock().toISOString(),
        );
      return id;
    });
  }

  /** Usage attributable by agent/provider/model, effective records only. */
  report(
    missionId: string,
    phase: BudgetPhase,
  ): {
    agent: string;
    provider: string;
    model: string;
    state: string;
    tokens: number;
    calls: number;
  }[] {
    return this.db
      .prepare(
        `SELECT agent, provider, model, state, SUM(charged_tokens) AS tokens, COUNT(*) AS calls FROM token_usage u
         WHERE mission_id = ? AND phase = ? AND NOT EXISTS (SELECT 1 FROM token_usage r WHERE r.reconciles = u.id)
         GROUP BY agent, provider, model, state ORDER BY tokens DESC`,
      )
      .all(missionId, phase) as {
      agent: string;
      provider: string;
      model: string;
      state: string;
      tokens: number;
      calls: number;
    }[];
  }
}
