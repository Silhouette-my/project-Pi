import type { ProjectGroupRecord, RemoteWorkspace } from "@pi-desktop/shared";

type FileHost = { call<T>(method: string, input?: unknown): Promise<T> };

export async function workspacePathForFiles(getHost: () => FileHost | null, sessionId?: string): Promise<string | null> {
  const owner = getHost();
  if (!owner) throw new Error("host unavailable");
  const path = sessionId
    ? await owner.call<{ session?: { projectPath?: string; worktree?: unknown } }>("session.get", { id: sessionId, messageLimit: 1 }).then(async ({ session }) => {
      if (!session) throw Object.assign(new Error("session not found"), { errorCode: "NOT_FOUND" });
      if (session.worktree) {
        const location = await owner.call<{ path: string }>("worktree.location", { sessionId });
        return location.path;
      }
      return session.projectPath;
    })
    : await owner.call<{ workspace?: { path: string } }>("workspace.get").then(({ workspace }) => workspace?.path);
  if (getHost() !== owner) throw Object.assign(new Error("host replaced"), { errorCode: "HOST_UNAVAILABLE" });
  return path ?? null;
}

/** Retained file views authorize against their own durable session, not the selected project. */
export async function remoteWorkspaceForFiles(getHost: () => FileHost | null, sessionId?: string): Promise<RemoteWorkspace | null> {
  const owner = getHost();
  if (!owner) throw new Error("host unavailable");
  const path = await workspacePathForFiles(getHost, sessionId);
  if (getHost() !== owner) throw Object.assign(new Error("host replaced"), { errorCode: "HOST_UNAVAILABLE" });
  if (!path?.startsWith("remote-project:")) return null;
  const { groups } = await owner.call<{ groups: ProjectGroupRecord[] }>("project.groups.list");
  if (getHost() !== owner) throw Object.assign(new Error("host replaced"), { errorCode: "HOST_UNAVAILABLE" });
  const remote = groups.find((group) => group.primaryPath === path)?.remote;
  if (!remote) throw Object.assign(new Error("remote workspace binding unavailable"), { errorCode: "NOT_FOUND" });
  return remote;
}
