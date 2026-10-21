import type { ProjectWorkflowSnapshot } from "@pi-desktop/shared";

export function projectOverview(snapshot: ProjectWorkflowSnapshot, projectId: string) {
  const workstreams = snapshot.workstreams
    .filter((item) => item.projectId === projectId)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const current = workstreams.filter(
    (item) => item.status !== "completed" && item.status !== "cancelled",
  );
  const currentIds = new Set(current.map((item) => item.id));
  return {
    workstreams,
    current,
    completed: workstreams.filter((item) => item.status === "completed").length,
    blockers: current.filter(
      (item) => item.blocker || item.status === "blocked" || item.status === "awaiting_user",
    ),
    decisions: snapshot.decisions
      .filter((item) => item.projectId === projectId && item.state === "proposed")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    unknownRuns: snapshot.runs.filter(
      (item) =>
        item.projectId === projectId &&
        (item.state === "unknown" || item.effects.some((effect) => effect.state === "unknown")),
    ),
    recentArtifacts: snapshot.artifacts
      .filter((item) => item.projectId === projectId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
      .slice(0, 3),
    executing: snapshot.runs.filter(
      (item) =>
        item.projectId === projectId &&
        currentIds.has(item.workstreamId) &&
        item.state === "executing",
    ).length,
  };
}
