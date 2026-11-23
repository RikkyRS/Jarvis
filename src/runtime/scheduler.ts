/**
 * Hierarchical concurrency: global, per Mission and per provider/model. A limit at any
 * scope wins; work waits (priority first, then FIFO) and never bypasses a limit.
 * Concurrency limits grant no tokens: budget reservation is a separate, atomic step.
 */
export type SchedulerLimits = {
  global: number;
  perMission: number;
  perProviderModel: number;
};

/** Initial values only; deployments are expected to configure their own. */
export const DEFAULT_LIMITS: SchedulerLimits = { global: 4, perMission: 2, perProviderModel: 2 };

export type Scope = { missionId: string; providerModel?: string };

type Waiter = { scope: Scope; priority: number; order: number; start: () => void };

export class Scheduler {
  private active = 0;
  private readonly byMission = new Map<string, number>();
  private readonly byModel = new Map<string, number>();
  private readonly queue: Waiter[] = [];
  private order = 0;

  constructor(private readonly limits: SchedulerLimits = DEFAULT_LIMITS) {
    for (const [k, v] of Object.entries(limits)) {
      if (!Number.isInteger(v) || v < 1)
        throw new Error(`Scheduler limit ${k} must be a positive integer.`);
    }
  }

  get stats(): { active: number; queued: number } {
    return { active: this.active, queued: this.queue.length };
  }

  private canStart(scope: Scope): boolean {
    if (this.active >= this.limits.global) return false;
    if ((this.byMission.get(scope.missionId) ?? 0) >= this.limits.perMission) return false;
    if (
      scope.providerModel &&
      (this.byModel.get(scope.providerModel) ?? 0) >= this.limits.perProviderModel
    )
      return false;
    return true;
  }

  private bump(scope: Scope, delta: 1 | -1): void {
    this.active += delta;
    this.byMission.set(scope.missionId, (this.byMission.get(scope.missionId) ?? 0) + delta);
    if (scope.providerModel)
      this.byModel.set(scope.providerModel, (this.byModel.get(scope.providerModel) ?? 0) + delta);
  }

  private pump(): void {
    // Highest priority first, then arrival order; skip blocked waiters so one saturated scope cannot starve others.
    this.queue.sort((a, b) => b.priority - a.priority || a.order - b.order);
    for (let i = 0; i < this.queue.length;) {
      const waiter = this.queue[i]!;
      if (this.canStart(waiter.scope)) {
        this.queue.splice(i, 1);
        this.bump(waiter.scope, 1);
        waiter.start();
      } else i += 1;
    }
  }

  async run<T>(scope: Scope, fn: () => Promise<T>, priority = 0): Promise<T> {
    await new Promise<void>((resolve) => {
      this.queue.push({ scope, priority, order: this.order++, start: resolve });
      this.pump();
    });
    try {
      return await fn();
    } finally {
      this.bump(scope, -1);
      this.pump();
    }
  }
}
