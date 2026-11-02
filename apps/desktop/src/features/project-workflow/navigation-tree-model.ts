import {
  WORKFLOW_CHATS_CATEGORY,
  WORKFLOW_PROJECTS_CATEGORY,
  type ProjectWorkflowSnapshot,
  type WorkflowFolder,
  type WorkflowTreeScope,
} from "@pi-desktop/shared";

/**
 * `chats` and `projects` are one category space (see ADR project-navigation-tree):
 * a category mixes folders, standalone conversations and projects. Only
 * `project` is a separate tree, one per project.
 */
export type TreeContext = { scope: WorkflowTreeScope; projectId?: string };
export type TreeEntry = {
  kind: "folder" | "session" | "project";
  id: string;
  label: string;
  /** A folder id, or `categoryRoot(id)` for an entry at a category's top level. */
  parentId?: string;
  order: number;
  rank?: number;
  /** Sessions: last activity, for the Recent group. */
  recency?: number;
  /** Projects only: the body is expanded, so the row renders as a shaded block. */
  open?: boolean;
};
const ROOT_PREFIX = "category:";
/** Pseudo parent id that places an entry at the top level of a category. */
export function categoryRoot(categoryId: string) {
  return `${ROOT_PREFIX}${categoryId}`;
}
/** The category a pseudo parent id stands for, or undefined for a real folder id. */
export function rootCategoryId(parentId?: string) {
  return parentId?.startsWith(ROOT_PREFIX) ? parentId.slice(ROOT_PREFIX.length) : undefined;
}
/** Legacy folders without `categoryId` derive it from their scope. */
export function folderCategory(folder: WorkflowFolder) {
  return folder.categoryId ?? (folder.scope === "projects" ? WORKFLOW_PROJECTS_CATEGORY : WORKFLOW_CHATS_CATEGORY);
}
export function folderInContext(folder: WorkflowFolder, context: TreeContext) {
  const projectTree = (folder.scope ?? "chats") === "project";
  return context.scope === "project"
    ? projectTree && folder.projectId === context.projectId
    : !projectTree;
}
export function treeFolders(snapshot: ProjectWorkflowSnapshot, context: TreeContext) {
  return snapshot.folders.filter((folder) => folderInContext(folder, context));
}
export function folderDescendants(folders: WorkflowFolder[], id: string): Set<string> {
  const result = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const folder of folders)
      if (folder.parentId && result.has(folder.parentId) && !result.has(folder.id)) {
        result.add(folder.id);
        changed = true;
      }
  }
  return result;
}
export function treeSiblings(entries: TreeEntry[], parentId?: string) {
  return entries
    .filter((entry) => entry.parentId === parentId)
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0) || a.order - b.order || a.id.localeCompare(b.id));
}
export function folderPath(folders: WorkflowFolder[], folder: WorkflowFolder): string {
  const parent = folders.find((item) => item.id === folder.parentId);
  return parent ? `${folderPath(folders, parent)} / ${folder.name}` : folder.name;
}
export type DropPosition = "before" | "inside" | "after";
export function dropPosition(kind: TreeEntry["kind"], fraction: number): DropPosition {
  if (kind === "folder" && fraction >= 0.25 && fraction <= 0.75) return "inside";
  return fraction < 0.5 ? "before" : "after";
}
/** One order space for folders and entries; no workspace or context mutation. */
export function treePlacement(
  entries: TreeEntry[],
  source: TreeEntry,
  target?: TreeEntry,
  position: DropPosition = "after",
  /** Parent used when there is no target: a category root, or the tree root. */
  rootId?: string,
) {
  if (source.id === target?.id && source.kind === target.kind) return null;
  if (target && position !== "inside") {
    const rank = (source.rank ?? 0) - (target.rank ?? 0);
    if ((position === "before" && rank > 0) || (position === "after" && rank < 0)) return null;
  }
  const parentId = position === "inside" ? target?.id : target ? target.parentId : rootId;
  if (source.kind === "folder") {
    const descendants = new Set([source.id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const entry of entries)
        if (
          entry.kind === "folder" &&
          entry.parentId &&
          descendants.has(entry.parentId) &&
          !descendants.has(entry.id)
        ) {
          descendants.add(entry.id);
          changed = true;
        }
    }
    if (parentId && descendants.has(parentId)) return null;
  }
  const siblings = treeSiblings(entries, parentId).filter((entry) => entry !== source);
  if (!target || position === "inside")
    return { folderId: parentId, order: (siblings.at(-1)?.order ?? -1) + 1 };
  const index = siblings.findIndex((entry) => entry.id === target.id && entry.kind === target.kind);
  const before = position === "before" ? siblings[index - 1] : target;
  const after = position === "before" ? target : siblings[index + 1];
  return {
    folderId: parentId,
    order:
      before && after
        ? (before.order + after.order) / 2
        : before
          ? before.order + 1
          : (after?.order ?? 0) - 1,
  };
}

/**
 * Which tree a session is organized in, or undefined when it is in none (a
 * session of a project without a workflow group). A folder placement wins;
 * otherwise a standalone chat belongs to Chats and a project conversation to
 * its project.
 */
export function sessionTreeContext(
  snapshot: ProjectWorkflowSnapshot,
  session: { id: string; projectPath?: string | null },
  projectId: string | undefined,
): TreeContext | undefined {
  const folderId = snapshot.navigation.find((item) => item.sessionId === session.id)?.folderId;
  const folder = folderId ? snapshot.folders.find((item) => item.id === folderId) : undefined;
  if (folder) return { scope: folder.scope ?? "chats", projectId: folder.projectId };
  if (projectId) return { scope: "project", projectId };
  return session.projectPath ? undefined : { scope: "chats" };
}
