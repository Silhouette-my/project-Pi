import { emptyProjectWorkflowSnapshot, type ProjectWorkflowSnapshot, type WorkflowWorkstream } from "./project-workflow.js";

/** Synthetic records shared by producer/consumer tests, never production defaults. */
export const workflowFixtureWorkstream: WorkflowWorkstream = {
  id: "work-1", projectId: "project-1", title: "Ship project continuity", goal: "Continue adopted work across sessions",
  acceptance: [{ id: "ac-1", title: "New session sees effective decisions", status: "pending", evidenceIds: [] }],
  owner: { kind: "session", ref: "session-1" }, status: "ready", priority: 0, order: 0,
  dependencyIds: [], nextAction: "Implement persistence", revision: 0, decisionRevision: 0,
  createdAt: "2026-10-20T00:00:00Z", updatedAt: "2026-10-20T00:00:00Z",
};
export function projectWorkflowFixture(): ProjectWorkflowSnapshot {
  return { ...emptyProjectWorkflowSnapshot(), workstreams: [structuredClone(workflowFixtureWorkstream)] };
}
