import type { WorkspaceDiff } from "./types/workpanel.js";

/** Project-scoped, read-only views. Root IDs are Host-registered root paths. */
export type ProjectStructureRoot = { rootId: string; rootPath: string; label: string };
export type ProjectGitCommit = {
  oid: string; parents: string[]; subject: string; authorName: string;
  authoredAt: string; refNames: string[];
};
export type ProjectGitRepository = ProjectStructureRoot & {
  isRepository: boolean; head: string | null; branch: string | null;
  refs: { name: string; oid: string }[]; commits: ProjectGitCommit[];
  changes: WorkspaceDiff; truncated: boolean; error?: string;
};
export type ProjectGitSnapshot = { projectId: string; repositories: ProjectGitRepository[] };
export type ProjectArchitectureSource = { path: string; line: number; endLine?: number };
export type ProjectArchitectureArtifact = {
  rootId: string; relativePath: string; kind: "html" | "json";
  title?: string; modifiedAt: number; size: number;
  sources: ProjectArchitectureSource[]; repositoryRevision?: string;
  /** meta.output, relative to the project root, when a saved HTML exists. */
  renderedPath?: string;
};
export type ProjectArchitectureSnapshot = {
  projectId: string; roots: ProjectStructureRoot[];
  artifacts: ProjectArchitectureArtifact[];
  errors: { rootId: string; relativePath?: string; message: string }[];
  truncated: boolean;
};
export type ProjectStructureQuery = { projectId: string };
export type ProjectGitDiffRequest = ProjectStructureQuery & { rootId: string; commit?: string };
export type ProjectStructureReadRequest = ProjectStructureQuery & {
  rootId: string; relativePath: string; kind: "artifact" | "source";
};
export type ProjectStructureFile = {
  relativePath: string; content: string; language: "html" | "json" | "text";
  /** Source reads always return the current working file, not a historical revision. */
  currentWorkingFile: boolean; truncated: boolean;
};
export type ProjectStructureApi = {
  gitSnapshot(input: ProjectStructureQuery): Promise<ProjectGitSnapshot>;
  gitDiff(input: ProjectGitDiffRequest): Promise<WorkspaceDiff>;
  architectureSnapshot(input: ProjectStructureQuery): Promise<ProjectArchitectureSnapshot>;
  readFile(input: ProjectStructureReadRequest): Promise<ProjectStructureFile>;
};
