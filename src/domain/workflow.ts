import type { WorkItemStatus, WorkflowRunStatus } from "./contracts.js";

/** Workflow state is durable data; transitions are the only way to change it. */
const RUN_TRANSITIONS: Readonly<Record<WorkflowRunStatus, readonly WorkflowRunStatus[]>> = {
  PLANNED: ["PREPARING", "CANCELLED"],
  PREPARING: ["AWAITING_EXECUTION_APPROVAL", "PAUSED", "FAILED", "CANCELLED"],
  AWAITING_EXECUTION_APPROVAL: ["RUNNING", "PREPARING", "CANCELLED"],
  RUNNING: ["PAUSED", "AWAITING_REVIEW", "FAILED", "CANCELLED"],
  PAUSED: ["PREPARING", "RUNNING", "CANCELLED"],
  AWAITING_REVIEW: ["COMPLETED", "RUNNING", "FAILED", "CANCELLED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

const ITEM_TRANSITIONS: Readonly<Record<WorkItemStatus, readonly WorkItemStatus[]>> = {
  OPEN: ["IN_PROGRESS", "CLOSED"],
  IN_PROGRESS: ["DELIVERED", "OPEN", "CLOSED"],
  DELIVERED: ["REOPENED", "CLOSED"],
  REOPENED: ["IN_PROGRESS", "CLOSED"],
  CLOSED: ["REOPENED"],
};

export class InvalidTransitionError extends Error {
  constructor(
    readonly entity: "WorkflowRun" | "WorkItem",
    readonly from: string,
    readonly to: string,
  ) {
    super(`${entity}: transition ${from} -> ${to} is not allowed.`);
    this.name = "InvalidTransitionError";
  }
}

export function canTransitionRun(from: WorkflowRunStatus, to: WorkflowRunStatus): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

export function transitionRun(from: WorkflowRunStatus, to: WorkflowRunStatus): WorkflowRunStatus {
  if (!canTransitionRun(from, to)) throw new InvalidTransitionError("WorkflowRun", from, to);
  return to;
}

export function isTerminalRun(status: WorkflowRunStatus): boolean {
  return RUN_TRANSITIONS[status].length === 0;
}

export function transitionItem(from: WorkItemStatus, to: WorkItemStatus): WorkItemStatus {
  if (!ITEM_TRANSITIONS[from].includes(to)) throw new InvalidTransitionError("WorkItem", from, to);
  return to;
}
