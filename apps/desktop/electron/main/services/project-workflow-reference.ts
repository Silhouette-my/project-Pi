import { resolveRealOpenablePath } from "@pi-desktop/host-runtime";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { ErrorCodes, type ProjectGroupRecord, type ProjectWorkflowHostPort, type ProjectWorkflowOpenedReference } from "@pi-desktop/shared";
import { parseAllowedExternalUrl } from "../safe-open-external";
import { workflowHost, type WorkflowHostConnection } from "./project-workflow-host";

export type WorkflowReferenceDependencies = {
  host: ProjectWorkflowHostPort;
  getHost: () => WorkflowHostConnection | null;
  openPath(path: string): Promise<string>;
  openExternal(url: string): Promise<void>;
};

/** Resolve durable identity, not a renderer-supplied path or the active session. */
export async function openProjectWorkflowReference(
  dependencies: WorkflowReferenceDependencies,
  input: unknown,
): Promise<ProjectWorkflowOpenedReference> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid();
  const request = input as Record<string, unknown>;
  if (Object.keys(request).some((key) => !["projectId", "kind", "id"].includes(key))
    || typeof request.projectId !== "string" || !request.projectId
    || typeof request.id !== "string" || !request.id
    || (request.kind !== "artifact" && request.kind !== "resource")) throw invalid();
  const snapshot = await dependencies.host.snapshot({ projectId: request.projectId });
  const record = request.kind === "artifact"
    ? snapshot.artifacts.find((item) => item.id === request.id && item.projectId === request.projectId)
    : snapshot.resources.find((item) => item.id === request.id && item.projectId === request.projectId);
  if (!record) throw Object.assign(new Error("Workflow reference not found"), { errorCode: ErrorCodes.NOT_FOUND });
  const uri = "entryPoint" in record ? record.entryPoint : record.uri;
  const external = parseAllowedExternalUrl(uri);
  if (external && /^https?:\/\//i.test(external)) {
    await dependencies.openExternal(external);
    return { opened: true, uri: external, revision: record.revision };
  }
  const { groups } = await workflowHost(dependencies.getHost).call<{ groups: ProjectGroupRecord[] }>("project.groups.list");
  const group = groups.find((item) => item.id === request.projectId);
  if (!group) throw Object.assign(new Error("Project not found"), { errorCode: ErrorCodes.NOT_FOUND });
  if (group.remote) throw Object.assign(new Error("Remote references require an explicit web entry point"), { errorCode: ErrorCodes.UNSUPPORTED });
  if (/^[a-z][a-z0-9+.-]+:/i.test(uri)) throw Object.assign(new Error("Unsupported reference URI"), { errorCode: ErrorCodes.UNAUTHORIZED });
  // Host project roots are canonical. Normalize the recorded entry point too:
  // on macOS /var and /private/var may name the same authorized file.
  const canonical = await realpath(isAbsolute(uri) ? uri : resolve(group.primaryPath, uri));
  const path = await resolveRealOpenablePath(canonical, group.primaryPath, group.roots.map((root) => root.path));
  if (!path) throw Object.assign(new Error("Reference is missing or outside this project's roots"), { errorCode: ErrorCodes.UNAUTHORIZED });
  if (!(await stat(path)).isFile()) throw Object.assign(new Error("Reference is not a file"), { errorCode: ErrorCodes.INVALID_ARGUMENT });
  const error = await dependencies.openPath(path);
  if (error) throw new Error(error);
  return { opened: true, uri: path, revision: record.revision };
}

function invalid(): Error {
  return Object.assign(new Error("Invalid workflow reference"), { errorCode: ErrorCodes.INVALID_ARGUMENT });
}
