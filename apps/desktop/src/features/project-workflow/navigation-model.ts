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

/** Keep the existing visible/manual order; multiple open roots of one group share one row. */
export function workflowProjectEntries<T extends { path: string; sessions: SessionSummary[] }>(
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
      const visible = { ...entry, sessions: [...entry.sessions] };
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

/** Two folder levels keep organizational trees shallow without changing execution context. */
export function folderParents(folders: WorkflowFolder[], folder?: WorkflowFolder) {
  const hasChildren = folder && folders.some((item) => item.parentId === folder.id);
  return folders.filter((item) => !item.parentId && item.id !== folder?.id && !hasChildren);
}

export function orderedFolders(folders: WorkflowFolder[], parentId?: string) {
  return folders
    .filter((folder) => folder.parentId === parentId)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}
