import type { WorkflowStatus } from "@pi-desktop/shared";

export type WorkflowStatusTone = "success" | "warning" | "error" | "decision" | "muted";

/**
 * Maps a workstream status onto the semantic status colors: running work keeps
 * the amber used by sidebar activity, a decision awaiting the user keeps the
 * pending-permission purple, and inactive states stay neutral.
 */
export function workflowStatusTone(status: WorkflowStatus): WorkflowStatusTone {
  switch (status) {
    case "ready":
    case "completed":
      return "success";
    case "executing":
      return "warning";
    case "blocked":
      return "error";
    case "awaiting_user":
      return "decision";
    default:
      return "muted";
  }
}
