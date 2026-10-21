import type { ProjectArchitectureArtifact, ProjectGitRepository } from "@pi-desktop/shared";

/** Unknown/partial Git reads cannot establish that generated and working sources match. */
export function architectureRevisionState(
  artifact: ProjectArchitectureArtifact,
  repository?: ProjectGitRepository,
): "unknown" | "stale" | "matches" {
  if (
    !artifact.repositoryRevision ||
    !repository?.head ||
    repository.error ||
    repository.changes.truncated
  )
    return "unknown";
  return artifact.repositoryRevision !== repository.head ||
    repository.changes.files.some((file) => !file.path.startsWith(".archify/"))
    ? "stale"
    : "matches";
}
