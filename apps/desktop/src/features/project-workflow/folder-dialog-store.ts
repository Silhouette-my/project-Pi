import { useSyncExternalStore } from "react";
import type { TreeContext } from "./navigation-tree-model";

/** What the folder dialog edits. Targets are navigation-only references. */
export type FolderDialogTarget = { kind: "folder" | "session"; id: string };
export type FolderDialogRequest =
  /** `parentId` is a folder id, or `categoryRoot(id)` to create at a category's top level. */
  | { mode: "create"; context: TreeContext; parentId?: string }
  | { mode: "rename"; context: TreeContext; folderId: string }
  | { mode: "move"; context: TreeContext; targets: FolderDialogTarget[] }
  | { mode: "category-create"; context: TreeContext }
  | { mode: "category-rename"; context: TreeContext; categoryId: string };

/**
 * A tiny request channel between the places that can ask for the dialog (the
 * project overflow menu, session row menus, folder row menus) and the one
 * NavigationTree that owns the matching context and renders it. It carries no
 * workflow state; the Host snapshot stays the only source of truth.
 */
let current: FolderDialogRequest | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

export function openFolderDialog(request: FolderDialogRequest) {
  current = request;
  emit();
}

export function closeFolderDialog() {
  if (!current) return;
  current = null;
  emit();
}

export function useFolderDialogRequest() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => null,
  );
}

export function sameTreeContext(left: TreeContext, right: TreeContext) {
  return left.scope === right.scope && left.projectId === right.projectId;
}
