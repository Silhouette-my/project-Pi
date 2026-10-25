import {
  WORKFLOW_CHATS_CATEGORY,
  WORKFLOW_PROJECTS_CATEGORY,
  type ProjectWorkflowSnapshot,
  type SessionSummary,
} from "@pi-desktop/shared";
import { categoryRoot, folderInContext, type TreeEntry } from "./navigation-tree-model";

export type SidebarCategory = { id: string; name: string; builtin: boolean };

/** Built-in 对话 and 项目 first, then the user's categories in their order. */
export function sidebarCategories(
  snapshot: ProjectWorkflowSnapshot,
  names: { chats: string; projects: string },
): SidebarCategory[] {
  const custom = [...(snapshot.categories ?? [])]
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map((category) => ({ id: category.id, name: category.name, builtin: false }));
  return [
    { id: WORKFLOW_CHATS_CATEGORY, name: names.chats, builtin: true },
    { id: WORKFLOW_PROJECTS_CATEGORY, name: names.projects, builtin: true },
    ...custom,
  ];
}

/** An id that no longer names a category (removed elsewhere) falls back to the built-in. */
function knownCategory(snapshot: ProjectWorkflowSnapshot, id: string | undefined, fallback: string) {
  if (!id) return fallback;
  if (id === WORKFLOW_CHATS_CATEGORY || id === WORKFLOW_PROJECTS_CATEGORY) return id;
  return snapshot.categories?.some((category) => category.id === id) ? id : fallback;
}

function categoryFolder(snapshot: ProjectWorkflowSnapshot, folderId: string | undefined) {
  const folder = folderId ? snapshot.folders.find((item) => item.id === folderId) : undefined;
  return folder && folderInContext(folder, { scope: "chats" }) ? folder : undefined;
}

/** Conversations of no project: the only sessions a category can hold. */
export function standaloneSessions(snapshot: ProjectWorkflowSnapshot, sessions: SessionSummary[]) {
  const linked = new Set([
    ...snapshot.conversations.map((item) => item.sessionId),
    ...(snapshot.projectAgents ?? []).map((item) => item.sessionId),
    ...(snapshot.workstreams ?? []).flatMap((item) => (item.mainSessionId ? [item.mainSessionId] : [])),
  ]);
  return sessions.filter((session) => !linked.has(session.id) && !session.projectPath);
}

/**
 * Sessions and projects as tree leaves. A folder placement wins; otherwise the
 * stored category (default Chats for conversations, Projects for projects) is
 * the top level they sit at. Pinned sessions rank first among their siblings.
 */
export function categoryLeaves(
  snapshot: ProjectWorkflowSnapshot,
  sessions: SessionSummary[],
  projects: { id: string; name: string; order: number; pinned?: boolean; archived?: boolean; open?: boolean }[],
  pinnedSessionIds: ReadonlySet<string>,
): TreeEntry[] {
  const nav = new Map(snapshot.navigation.map((row) => [row.sessionId, row]));
  const placements = new Map((snapshot.projectNavigation ?? []).map((row) => [row.projectId, row]));
  const sessionLeaves = sessions.map((session, index): TreeEntry => {
    const row = nav.get(session.id);
    const folder = categoryFolder(snapshot, row?.folderId);
    const touched = Math.max(Date.parse(session.updatedAt) || 0, Date.parse(row?.lastAccessedAt ?? "") || 0);
    return {
      kind: "session",
      id: session.id,
      label: session.title,
      parentId: folder
        ? folder.id
        : categoryRoot(knownCategory(snapshot, row?.categoryId, WORKFLOW_CHATS_CATEGORY)),
      order: row?.order ?? index,
      rank: pinnedSessionIds.has(session.id) ? -1 : 0,
      recency: touched,
    };
  });
  const projectLeaves = projects.map((project): TreeEntry => {
    const row = placements.get(project.id);
    const folder = categoryFolder(snapshot, row?.folderId);
    return {
      kind: "project",
      id: project.id,
      label: project.name,
      parentId: folder
        ? folder.id
        : categoryRoot(knownCategory(snapshot, row?.categoryId, WORKFLOW_PROJECTS_CATEGORY)),
      order: row?.order ?? project.order,
      rank: project.archived ? 1 : project.pinned ? -1 : 0,
      open: project.open,
    };
  });
  return [...sessionLeaves, ...projectLeaves];
}

/** Newest first, pinned first: the order of the built-in 最近 group. */
export function recentOrder(entries: TreeEntry[]) {
  return [...entries].sort(
    (a, b) => (a.rank ?? 0) - (b.rank ?? 0) || (b.recency ?? 0) - (a.recency ?? 0) || a.id.localeCompare(b.id),
  );
}

/**
 * The Favorites view, conversations: every favourited conversation wherever it
 * lives (standalone, project chat, workstream), newest activity first. Side-only
 * and Agent sessions are not sidebar rows, so they are never listed. The flag is
 * on the persisted navigation record; nothing here writes data.
 */
export function favoriteSessions(snapshot: ProjectWorkflowSnapshot, sessions: SessionSummary[]) {
  const nav = new Map(snapshot.navigation.map((row) => [row.sessionId, row]));
  const hidden = new Set([
    ...(snapshot.projectAgents ?? []).map((item) => item.sessionId),
    ...snapshot.conversations.filter((item) => item.visibility === "side_only").map((item) => item.sessionId),
  ]);
  const touched = (session: SessionSummary) =>
    Math.max(Date.parse(session.updatedAt) || 0, Date.parse(nav.get(session.id)?.lastAccessedAt ?? "") || 0);
  return sessions
    .filter((session) => nav.get(session.id)?.favorite === true && !hidden.has(session.id))
    .sort((a, b) => touched(b) - touched(a) || a.id.localeCompare(b.id));
}

/** The Favorites view, projects: favourited, unarchived, in their tree order. */
export function favoriteProjects<T extends { id: string; order: number; archived?: boolean }>(
  snapshot: ProjectWorkflowSnapshot,
  projects: T[],
) {
  const starred = new Set(
    (snapshot.projectNavigation ?? []).filter((row) => row.favorite === true).map((row) => row.projectId),
  );
  return projects
    .filter((project) => starred.has(project.id) && !project.archived)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}
