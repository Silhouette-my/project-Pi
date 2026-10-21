import type { WorkflowRun } from "@pi-desktop/shared";
import type { WorkflowStep } from "./project-workflow-checkpoint";

/** Runtime-owned details of the admitted bounded assignment, not new authority. */
export type WorkflowAssignmentReceipt = { step: WorkflowStep; deliveryIds: string[]; turnId?: string; pausePendingShell?: boolean; resumedFromRunId?: string };
export function workflowAssignment(run: WorkflowRun): WorkflowAssignmentReceipt {
  return JSON.parse(run.effects.find((effect) => effect.id === "dispatch")!.detail);
}
export function workflowTurnId(run: WorkflowRun): string | undefined {
  const dispatch = run.effects.find((effect) => effect.id === "dispatch");
  return dispatch?.state === "confirmed" ? workflowAssignment(run).turnId : undefined;
}
export const resumableWorkflowPause = (run: WorkflowRun) => run.completionKey?.endsWith(":paused-before-start")
  || run.completionKey?.endsWith(":paused-before-shell");
