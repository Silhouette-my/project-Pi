import type {
  ProjectGroupRecord,
  ProjectWorkflowSnapshot,
  SessionSummary,
  WorkflowFolder,
} from "@pi-desktop/shared";
import { normalizeProjectPath } from "../../lib/sidebar-session-groups";

export function workflowGroupForPath(groups: ProjectGroupRecord[], path: string) {
  const normalized = normalizeProjectPath(path);
  return groups.find(
    (group) =>
      normalizeProjectPath(group.primaryPath) === normalized ||
      group.roots.some((root) => normalizeProjectPath(root.path) === normalized),
  );
}

/** A standalone Chat does not inherit the last workspace's project context. */
export function workflowContextProjectId(
  snapshot: ProjectWorkflowSnapshot | null,
  groups: ProjectGroupRecord[],
  session?: Pick<SessionSummary, "id" | "projectPath">,
  workspacePath?: string | null,
) {
  if (session) {
    const linked = snapshot?.projectAgents?.find(item => item.sessionId === session.id)?.projectId
      ?? snapshot?.conversations.find(item => item.sessionId === session.id)?.projectId
      ?? snapshot?.workstreams.find(item => item.mainSessionId === session.id)?.projectId;
    if (linked) return linked;
  }
  const path = session ? session.projectPath : workspacePath;
  return path ? workflowGroupForPath(groups, path)?.id : undefined;
}

/** Keep the existing visible/manual order; multiple open roots of one group share one row. */
export function workflowProjectEntries<T extends { path: string; sessions: SessionSummary[]; name?: string; meta?: { name?: string } }>(
  entries: T[],
  groups: ProjectGroupRecord[],
): T[] {
  const result: T[] = [];
  const byGroup = new Map<string, T>();
  for (const entry of entries) {
    const group = workflowGroupForPath(groups, entry.path);
    const existing = group && byGroup.get(group.id);
    if (existing) {
      const ids = new Set(existing.sessions.map((session) => session.id));
      existing.sessions = [
        ...existing.sessions,
        ...entry.sessions.filter((session) => !ids.has(session.id)),
      ];
    } else {
      const visible = { ...entry, name: entry.meta?.name ?? group?.name ?? entry.name, sessions: [...entry.sessions] };
      result.push(visible);
      if (group) byGroup.set(group.id, visible);
    }
  }
  return result;
}

export function navigationSessions(
  snapshot: ProjectWorkflowSnapshot,
  sessions: SessionSummary[],
  folderId?: string,
) {
  const linked = new Set([
    ...snapshot.conversations.map((item) => item.sessionId),
    ...(snapshot.projectAgents ?? []).map((item) => item.sessionId),
    ...(snapshot.workstreams ?? []).flatMap((item) => item.mainSessionId ? [item.mainSessionId] : []),
  ]);
  const navigation = new Map(snapshot.navigation.map((item) => [item.sessionId, item]));
  return sessions
    .filter(
      (session) =>
        !linked.has(session.id) &&
        !session.projectPath &&
        navigation.get(session.id)?.folderId === folderId,
    )
    .sort(
      (a, b) =>
        (navigation.get(a.id)?.order ?? 0) - (navigation.get(b.id)?.order ?? 0) ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id),
    );
}

/** Highlight a chat once; Favorites wins over Recent without changing its folder. */
export function navigationHighlights(snapshot: ProjectWorkflowSnapshot, sessions: SessionSummary[]) {
  const associated = new Set([
    ...snapshot.conversations.map((item) => item.sessionId),
    ...(snapshot.projectAgents ?? []).map((item) => item.sessionId),
    ...(snapshot.workstreams ?? []).flatMap((item) => item.mainSessionId ? [item.mainSessionId] : []),
  ]);
  const eligible = sessions.filter((item) => !item.projectPath && !associated.has(item.id));
  const byId = new Map(eligible.map((item) => [item.id, item]));
  const favorites = snapshot.navigation
    .filter((item) => item.favorite && byId.has(item.sessionId))
    .sort((left, right) => left.order - right.order)
    .map((item) => byId.get(item.sessionId)!);
  const recent = snapshot.navigation
    .filter((item) => item.lastAccessedAt && !item.favorite && byId.has(item.sessionId))
    .sort((left, right) => right.lastAccessedAt!.localeCompare(left.lastAccessedAt!))
    .slice(0, 5)
    .map((item) => byId.get(item.sessionId)!);
  return { favorites, recent, promotedIds: new Set([...favorites, ...recent].map((item) => item.id)) };
}

/** Any depth is allowed; only the edited folder and its descendants are excluded. */
export function folderParents(folders: WorkflowFolder[], folder?: WorkflowFolder) {
  if (!folder) return folders;
  const excluded = new Set([folder.id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of folders) if (item.parentId && excluded.has(item.parentId) && !excluded.has(item.id)) { excluded.add(item.id); changed = true; }
  }
  return folders.filter(item => !excluded.has(item.id));
}

export function orderedFolders(folders: WorkflowFolder[], parentId?: string) {
  return folders
    .filter((folder) => folder.parentId === parentId)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}
