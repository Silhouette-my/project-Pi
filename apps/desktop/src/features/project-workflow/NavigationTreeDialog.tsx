import { useTranslation } from "react-i18next";
import { WORKFLOW_PROJECTS_CATEGORY, type WorkflowFolder } from "@pi-desktop/shared";
import { FolderDialog, type FolderDialogChoice, type FolderDialogValues } from "./FolderDialog";
import { closeFolderDialog, sameTreeContext, useFolderDialogRequest } from "./folder-dialog-store";
import type { NavigationCategory } from "./NavigationTree";
import { useProjectWorkflow } from "./useProjectWorkflow";
import {
  categoryRoot,
  folderCategory,
  folderDescendants,
  folderPath,
  rootCategoryId,
  treeSiblings,
  type DropPosition,
  type TreeContext,
  type TreeEntry,
} from "./navigation-tree-model";

type Move = (
  source: TreeEntry,
  target?: TreeEntry,
  position?: DropPosition,
  rootId?: string,
) => Promise<boolean>;

/**
 * The create / rename / move dialogs of one NavigationTree. It owns no state
 * beyond the request channel; every change is a Host command.
 */
export function NavigationTreeDialog({
  context,
  entries,
  folders,
  categories,
  move,
}: {
  context: TreeContext;
  entries: TreeEntry[];
  folders: WorkflowFolder[];
  categories?: NavigationCategory[];
  move: Move;
}) {
  const { t } = useTranslation();
  const workflow = useProjectWorkflow();
  const snapshot = workflow.snapshot;
  const request = useFolderDialogRequest();
  const active = request && sameTreeContext(request.context, context) ? request : null;
  if (!snapshot || !active) return null;
  const key = (entry: TreeEntry) => `${entry.kind}:${entry.id}`;

  if (active.mode === "category-create" || active.mode === "category-rename") {
    const editing =
      active.mode === "category-rename"
        ? snapshot.categories?.find((item) => item.id === active.categoryId)
        : undefined;
    if (active.mode === "category-rename" && !editing) return null;
    return (
      <FolderDialog
        key={`${active.mode}:${editing?.id ?? ""}`}
        mode={active.mode === "category-create" ? "create" : "rename"}
        entity="category"
        initialName={editing?.name}
        choices={[]}
        busy={workflow.busy}
        error={workflow.error}
        onClose={closeFolderDialog}
        onSubmit={async (values) => {
          if (!values.name) return false;
          const order =
            editing?.order ?? Math.max(-1, ...(snapshot.categories ?? []).map((item) => item.order)) + 1;
          const category = { id: editing?.id ?? crypto.randomUUID(), name: values.name, order };
          return !!(await workflow.mutate({
            kind: editing ? "category.update" : "category.create",
            category,
          }));
        }}
      />
    );
  }

  const editing =
    active.mode === "rename" ? folders.find((folder) => folder.id === active.folderId) : undefined;
  const moving =
    active.mode === "move"
      ? active.targets.flatMap((target) => {
          const found = entries.find((entry) => entry.kind === target.kind && entry.id === target.id);
          return found ? [found] : [];
        })
      : [];
  if ((active.mode === "rename" && !editing) || (active.mode === "move" && !moving.length)) return null;

  const excluded = (id?: string) => (id ? folderDescendants(folders, id) : new Set<string>());
  const folderChoices = (id?: string) => {
    const skip = excluded(id);
    return folders
      .filter((folder) => !skip.has(folder.id))
      .map((folder) => ({
        id: folder.id,
        label: categories
          ? `${categories.find((item) => item.id === folderCategory(folder))?.name ?? ""} / ${folderPath(folders, folder)}`
          : folderPath(folders, folder),
      }));
  };
  const choices: FolderDialogChoice[] = categories
    ? categories.flatMap((category) => [
        { id: categoryRoot(category.id), label: category.name },
        ...folderChoices(editing?.id ?? (moving.length === 1 && moving[0].kind === "folder" ? moving[0].id : undefined))
          .filter((choice) => {
            const folder = folders.find((item) => item.id === choice.id);
            return folder && folderCategory(folder) === category.id;
          }),
      ])
    : folderChoices(
        active.mode === "rename"
          ? editing?.id
          : moving.length === 1 && moving[0].kind === "folder"
            ? moving[0].id
            : undefined,
      );

  async function submit(values: FolderDialogValues) {
    if (active?.mode === "move") {
      const parent = values.parentId || undefined;
      const destination = parent
        ? entries.find((entry) => entry.kind === "folder" && entry.id === parent)
        : undefined;
      // Moving to the start in reverse keeps the selected chats in their order.
      for (const source of values.first ? [...moving].reverse() : moving) {
        const first = values.first
          ? treeSiblings(entries, parent).find(
              (entry) => key(entry) !== key(source) && (entry.rank ?? 0) === (source.rank ?? 0),
            )
          : undefined;
        const ok = first
          ? await move(source, first, "before")
          : destination
            ? await move(source, destination, "inside")
            : await move(source, undefined, "after", parent);
        if (!ok) return false;
      }
      return true;
    }
    if (!values.name) return false;
    const parent = values.parentId || undefined;
    const category = rootCategoryId(parent);
    const folderParent = category ? undefined : parent;
    const parentFolder = folderParent ? folders.find((folder) => folder.id === folderParent) : undefined;
    const categoryId = categories
      ? (category ?? (parentFolder ? folderCategory(parentFolder) : undefined) ?? editing?.categoryId)
      : undefined;
    const folder: WorkflowFolder = {
      ...editing,
      id: editing?.id ?? crypto.randomUUID(),
      name: values.name,
      parentId: editing ? editing.parentId : folderParent,
      order:
        editing?.order ??
        Math.max(-1, ...treeSiblings(entries, parent).map((entry) => entry.order)) + 1,
      scope: editing?.scope ?? (categoryId === WORKFLOW_PROJECTS_CATEGORY ? "projects" : context.scope),
      projectId: context.projectId,
      ...(categoryId ? { categoryId } : {}),
    };
    const result = await workflow.mutate({ kind: editing ? "folder.update" : "folder.create", folder });
    // A new subfolder opens its parent, so the result is visible where it was made.
    if (result && !editing && folderParent && !result.snapshot.expandedIds.includes(folderParent))
      await workflow.mutate({
        kind: "navigation.expand",
        expandedIds: [...result.snapshot.expandedIds, folderParent],
      });
    return !!result;
  }

  const first = moving[0];
  const initialParent =
    active.mode === "create"
      ? (active.parentId ?? "")
      : active.mode === "move" && moving.length === 1
        ? (first.parentId ?? "")
        : "";
  return (
    <FolderDialog
      key={`${active.mode}:${active.mode === "rename" ? active.folderId : ""}`}
      mode={active.mode}
      hideTopLevel={!!categories}
      title={
        moving.length === 1
          ? t("workflowNav.moveItem", { title: moving[0].label })
          : t("workflowNav.moveSelected", { count: moving.length })
      }
      initialName={editing?.name}
      initialParentId={categories && !initialParent ? (choices[0]?.id ?? "") : initialParent}
      choices={choices}
      busy={workflow.busy}
      error={workflow.error}
      onClose={closeFolderDialog}
      onSubmit={submit}
    />
  );
}
