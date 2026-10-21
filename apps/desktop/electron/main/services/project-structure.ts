import { collectProjectArchitecture, collectProjectGit, readProjectGitDiff, readProjectStructureFile, validateCommitOid, validateProjectRelativePath } from "@pi-desktop/host-runtime";
import { ErrorCodes, type ProjectGroupRecord, type ProjectStructureRoot } from "@pi-desktop/shared";
import { workflowHost, type WorkflowHostConnection } from "./project-workflow-host";

function invalid(message = "Invalid project structure request"): Error {
  return Object.assign(new Error(message), { errorCode: ErrorCodes.INVALID_ARGUMENT });
}

function request(input: unknown, fields: string[]): Record<string, unknown> & { projectId: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid();
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !["projectId", ...fields].includes(key)) || typeof value.projectId !== "string" || !value.projectId || value.projectId.length > 1024) throw invalid();
  return value as Record<string, unknown> & { projectId: string };
}

/** Always resolve the durable project before filesystem/Git reads; active session is irrelevant. */
export function createProjectStructureService(getHost: () => WorkflowHostConnection | null) {
  async function roots(projectId: string): Promise<ProjectStructureRoot[]> {
    const { groups } = await workflowHost(getHost).call<{ groups: ProjectGroupRecord[] }>("project.groups.list");
    const project = groups.find((item) => item.id === projectId);
    if (!project) throw Object.assign(new Error("Project not found"), { errorCode: ErrorCodes.NOT_FOUND });
    if (project.remote) throw Object.assign(new Error("Structure views require a local project"), { errorCode: ErrorCodes.UNSUPPORTED });
    const registered = [...project.roots];
    if (!registered.some((root) => root.path === project.primaryPath)) registered.unshift({ path: project.primaryPath, name: project.name, position: -1 });
    return registered.map((root) => ({ rootId: root.path, rootPath: root.path, label: root.name }));
  }
  async function selected(value: Record<string, unknown> & { projectId: string }): Promise<ProjectStructureRoot> {
    if (typeof value.rootId !== "string") throw invalid();
    const root = (await roots(value.projectId)).find((item) => item.rootId === value.rootId);
    if (!root) throw Object.assign(new Error("Root does not belong to this project"), { errorCode: ErrorCodes.UNAUTHORIZED });
    return root;
  }
  return {
    async gitSnapshot(input: unknown) {
      const value = request(input, []);
      return { projectId: value.projectId, repositories: await Promise.all((await roots(value.projectId)).map(collectProjectGit)) };
    },
    async gitDiff(input: unknown) {
      const value = request(input, ["rootId", "commit"]);
      if (value.commit !== undefined) {
        if (typeof value.commit !== "string") throw invalid();
        validateCommitOid(value.commit);
      }
      const root = await selected(value);
      return readProjectGitDiff(root.rootPath, value.commit as string | undefined);
    },
    async architectureSnapshot(input: unknown) {
      const value = request(input, []);
      return collectProjectArchitecture(value.projectId, await roots(value.projectId));
    },
    async readFile(input: unknown) {
      const value = request(input, ["rootId", "relativePath", "kind"]);
      if (typeof value.relativePath !== "string" || value.relativePath.length > 4096 || (value.kind !== "artifact" && value.kind !== "source")) throw invalid();
      validateProjectRelativePath(value.relativePath);
      const root = await selected(value);
      return readProjectStructureFile(root.rootPath, value.relativePath, value.kind);
    },
  };
}
