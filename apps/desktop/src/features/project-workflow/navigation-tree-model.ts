import type {
  ProjectWorkflowSnapshot,
  WorkflowFolder,
  WorkflowTreeScope,
} from "@pi-desktop/shared";

export type TreeContext = { scope: WorkflowTreeScope; projectId?: string };
export type TreeEntry = {
  kind: "folder" | "session" | "project";
  id: string;
  label: string;
  parentId?: string;
  order: number;
  rank?: number;
};
export function folderInContext(folder: WorkflowFolder, context: TreeContext) {
  return (folder.scope ?? "chats") === context.scope && folder.projectId === context.projectId;
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
) {
  if (source.id === target?.id && source.kind === target.kind) return null;
  if (target && position !== "inside") {
    const rank = (source.rank ?? 0) - (target.rank ?? 0);
    if ((position === "before" && rank > 0) || (position === "after" && rank < 0)) return null;
  }
  const parentId = position === "inside" ? target?.id : target?.parentId;
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
