import { useState, type DragEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { WorkflowFolder } from "@pi-desktop/shared";
import { Button, TooltipButton } from "../../components/ui";
import { IconChevronDown, IconFolder, IconMore, IconPencil, IconTrash, IconArrowUpDown } from "../../components/icons";
import { useArmedDelete } from "../../hooks/use-armed-delete";
import { sidebarMenuAction, type SidebarMenuPanelContent } from "../../lib/sidebar-menu";
import { FolderDialog, type FolderDialogValues } from "./FolderDialog";
import {
  closeFolderDialog,
  openFolderDialog,
  sameTreeContext,
  useFolderDialogRequest,
} from "./folder-dialog-store";
import { useRowMenu } from "./useRowMenu";
import { useProjectWorkflow } from "./useProjectWorkflow";
import {
  dropPosition,
  folderDescendants,
  folderPath,
  treeFolders,
  treePlacement,
  treeSiblings,
  type DropPosition,
  type TreeContext,
  type TreeEntry,
} from "./navigation-tree-model";
import "./navigation-styles.css";

const MIME = "application/x-pi-navigation-tree";
type Props = {
  context: TreeContext;
  entries: TreeEntry[];
  renderEntry: (entry: TreeEntry) => ReactNode;
  label: string;
  /** Render the section header row (label plus New folder and extra actions). */
  toolbar?: boolean;
  toolbarActions?: ReactNode;
  shortcuts?: { label: string; ids: string[] }[];
  hiddenRootIds?: string[];
  renderFolderActions?: (folder: WorkflowFolder) => ReactNode;
};
/** The Host owns placement; local state only describes the current gesture. */
export function NavigationTree({
  context,
  entries: leaves,
  renderEntry,
  label,
  toolbar = true,
  toolbarActions,
  shortcuts = [],
  hiddenRootIds = [],
  renderFolderActions,
}: Props) {
  const { t } = useTranslation();
  const workflow = useProjectWorkflow();
  const snapshot = workflow.snapshot;
  const request = useFolderDialogRequest();
  const { armed, setArmed } = useArmedDelete();
  const [dragging, setDragging] = useState<TreeEntry | null>(null);
  const [drop, setDrop] = useState<{ key: string; position: DropPosition } | null>(null);
  const folders = snapshot ? treeFolders(snapshot, context) : [];
  const folderMenu = useRowMenu((id): SidebarMenuPanelContent | null => {
    const folder = folders.find((item) => item.id === id);
    if (!folder) return null;
    const confirming = armed === folder.id;
    return {
      label: t("workflowNav.folderActions"),
      items: [
        sidebarMenuAction({
          id: "rename-folder",
          label: t("workflowNav.renameFolder"),
          icon: <IconPencil size={14} />,
          onSelect: () => {
            folderMenu.close(false);
            openFolderDialog({ mode: "rename", context, folderId: folder.id });
          },
        }),
        sidebarMenuAction({
          id: "move-folder",
          label: t("workflowNav.moveTo"),
          icon: <IconArrowUpDown size={14} />,
          onSelect: () => {
            folderMenu.close(false);
            openFolderDialog({
              mode: "move",
              context,
              targets: [{ kind: "folder", id: folder.id }],
            });
          },
        }),
        sidebarMenuAction({
          id: "remove-folder",
          label: confirming ? t("workflowNav.removeFolderConfirm") : t("workflowNav.removeFolder"),
          icon: <IconTrash size={14} />,
          danger: true,
          armed: confirming,
          disabled: workflow.busy,
          separatorBefore: true,
          onSelect: () => {
            if (!confirming) {
              setArmed(folder.id);
              return;
            }
            setArmed(null);
            folderMenu.close(false);
            void workflow.mutate({ kind: "folder.remove", folderId: folder.id });
          },
        }),
      ],
      notes: confirming ? [{ id: "remove-hint", text: t("workflowNav.removeHint") }] : undefined,
    };
  });
  if (!snapshot) return <>{leaves.map(renderEntry)}</>;
  const entries: TreeEntry[] = [
    ...leaves,
    ...folders.map((folder) => ({
      kind: "folder" as const,
      id: folder.id,
      label: folder.name,
      parentId: folder.parentId,
      order: folder.order,
    })),
  ];
  const key = (entry: TreeEntry) => `${entry.kind}:${entry.id}`;
  const forbidden = (id?: string) => (id ? folderDescendants(folders, id) : new Set<string>());
  const choices = (id?: string) =>
    folders
      .filter((folder) => !forbidden(id).has(folder.id))
      .map((folder) => ({ id: folder.id, label: folderPath(folders, folder) }));
  const toggle = (id: string) =>
    workflow.mutate({
      kind: "navigation.expand",
      expandedIds: snapshot.expandedIds.includes(id)
        ? snapshot.expandedIds.filter((item) => item !== id)
        : [...snapshot.expandedIds, id],
    });
  /** Resolves false only when the Host rejected the move; a no-op counts as done. */
  async function move(source: TreeEntry, target?: TreeEntry, position: DropPosition = "after") {
    const placement = treePlacement(entries, source, target, position);
    if (!placement) return true;
    const siblings = treeSiblings(entries, placement.folderId).filter(
      (entry) => key(entry) !== key(source),
    );
    const index =
      target && position !== "inside"
        ? siblings.findIndex((entry) => key(entry) === key(target)) + (position === "after" ? 1 : 0)
        : siblings.length;
    siblings.splice(index, 0, source);
    const siblingOrder = siblings.map(({ kind, id }) => ({ kind, id }));
    const result = await workflow.mutate({
      kind: "tree.move",
      target: { kind: source.kind, id: source.id },
      ...context,
      ...placement,
      siblingOrder,
    });
    if (result && placement.folderId && !result.snapshot.expandedIds.includes(placement.folderId)) {
      await workflow.mutate({
        kind: "navigation.expand",
        expandedIds: [...result.snapshot.expandedIds, placement.folderId],
      });
    }
    return !!result;
  }
  function over(event: DragEvent, entry?: TreeEntry) {
    if (!dragging || !event.dataTransfer.types.includes(MIME)) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const position = entry
      ? dropPosition(entry.kind, (event.clientY - rect.top) / rect.height)
      : "inside";
    const placement = treePlacement(entries, dragging, entry, entry ? position : "after");
    event.dataTransfer.dropEffect = placement ? "move" : "none";
    setDrop(placement ? { key: entry ? key(entry) : "root", position } : null);
  }
  const dialogRequest = request && sameTreeContext(request.context, context) ? request : null;
  const editing =
    dialogRequest?.mode === "rename"
      ? folders.find((folder) => folder.id === dialogRequest.folderId)
      : undefined;
  const moving =
    dialogRequest?.mode === "move"
      ? dialogRequest.targets.flatMap((target) => {
          const found = entries.find((entry) => entry.kind === target.kind && entry.id === target.id);
          return found ? [found] : [];
        })
      : [];
  async function submitDialog(values: FolderDialogValues) {
    if (!dialogRequest) return false;
    if (dialogRequest.mode === "move") {
      const destination = values.parentId
        ? entries.find((entry) => entry.kind === "folder" && entry.id === values.parentId)
        : undefined;
      // Moving to the start in reverse keeps the selected chats in their order.
      for (const source of values.first ? [...moving].reverse() : moving) {
        const first = values.first
          ? treeSiblings(entries, values.parentId || undefined).find(
              (entry) => key(entry) !== key(source) && (entry.rank ?? 0) === (source.rank ?? 0),
            )
          : undefined;
        const ok = values.first
          ? await move(source, first, "before")
          : await move(source, destination, destination ? "inside" : "after");
        if (!ok) return false;
      }
      return true;
    }
    if (!values.name) return false;
    const folder: WorkflowFolder = {
      ...editing,
      id: editing?.id ?? crypto.randomUUID(),
      name: values.name,
      parentId: values.parentId || undefined,
      order:
        editing?.order ??
        Math.max(-1, ...treeSiblings(entries, values.parentId || undefined).map((entry) => entry.order)) + 1,
      ...context,
    };
    return !!(await workflow.mutate({ kind: editing ? "folder.update" : "folder.create", folder }));
  }
  function row(entry: TreeEntry): ReactNode {
    const folder =
      entry.kind === "folder" ? folders.find((folder) => folder.id === entry.id)! : undefined;
    const open = snapshot!.expandedIds.includes(entry.id);
    const count = folder
      ? (() => {
          const inside = folderDescendants(folders, folder.id);
          return entries.filter(
            (item) => item.kind !== "folder" && item.parentId && inside.has(item.parentId),
          ).length;
        })()
      : 0;
    return (
      <div
        key={key(entry)}
        className={`workflow-tree-node${dragging && key(dragging) === key(entry) ? " is-dragging" : ""}`}
        data-workflow-tree-node={key(entry)}
        data-workflow-folder={folder?.id}
      >
        <div
          className={`workflow-tree-row${folder ? " is-folder" : ""}${drop?.key === key(entry) ? ` is-drop-${drop.position}` : ""}${folder && folderMenu.openId === folder.id ? " is-menu-open" : ""}`}
          draggable={!workflow.busy}
          onContextMenu={(event) => {
            if (!folder) return;
            event.preventDefault();
            event.stopPropagation();
            folderMenu.open(folder.id, null, { x: event.clientX, y: event.clientY });
          }}
          onDragStartCapture={(event) => {
            if (
              (event.target as Element).closest("[data-workflow-tree]") !==
              event.currentTarget.closest("[data-workflow-tree]")
            )
              return;
            if (workflow.busy) {
              event.preventDefault();
              return;
            }
            event.stopPropagation();
            setDragging(entry);
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData(MIME, key(entry));
          }}
          onDragEnd={() => {
            setDragging(null);
            setDrop(null);
          }}
          onDragOver={(event) => over(event, entry)}
          onDrop={(event) => {
            if (!dragging || !event.dataTransfer.types.includes(MIME)) return;
            event.preventDefault();
            event.stopPropagation();
            const position = drop?.key === key(entry) ? drop.position : "after";
            void move(dragging, entry, position);
            setDragging(null);
            setDrop(null);
          }}
        >
          <div className="workflow-tree-content">
            {folder ? (
              <Button
                variant="ghost"
                className="workflow-navigation-label"
                aria-expanded={open}
                onClick={() => void toggle(folder.id)}
              >
                <IconChevronDown size={12} className={open ? "" : "workflow-navigation-folded"} />
                <IconFolder size={13} />
                <span>{folder.name}</span>
              </Button>
            ) : (
              renderEntry(entry)
            )}
          </div>
          {folder ? (
            <div className="workflow-tree-meta">
              {!open && count > 0 ? <span className="workflow-tree-count">{count}</span> : null}
              <div className="workflow-tree-actions">
                {renderFolderActions?.(folder)}
                <TooltipButton
                  type="button"
                  className="thread-item-more"
                  data-action="folder-menu"
                  tooltip={t("workflowNav.folderActions")}
                  ariaLabel={t("workflowNav.folderActions")}
                  aria-haspopup="menu"
                  aria-expanded={folderMenu.openId === folder.id}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (folderMenu.openId === folder.id) folderMenu.close();
                    else folderMenu.open(folder.id, event.currentTarget);
                  }}
                >
                  <IconMore size={14} />
                </TooltipButton>
              </div>
            </div>
          ) : null}
        </div>
        {folder && open ? (
          <div className="workflow-navigation-children">
            {treeSiblings(entries, folder.id).map(row)}
            {treeSiblings(entries, folder.id).length === 0 ? (
              <div className="workflow-tree-empty">{t("workflowNav.emptyFolder")}</div>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <section
      className="workflow-navigation-tree"
      aria-label={label}
      data-workflow-tree={context.scope}
      data-project-id={context.projectId}
    >
      {toolbar ? (
        <div className="workflow-tree-toolbar">
          <span>{label}</span>
          <div className="sidebar-toolbar-actions">
            {toolbarActions}
            <TooltipButton
              className="sidebar-toolbar-button"
              tooltip={t("workflowNav.newFolder")}
              ariaLabel={t("workflowNav.newFolder")}
              onClick={() => openFolderDialog({ mode: "create", context })}
            >
              <IconFolder size={13} />
            </TooltipButton>
          </div>
        </div>
      ) : null}
      {workflow.error && !dialogRequest ? (
        <p role="alert" className="workflow-navigation-error">
          {workflow.error}
        </p>
      ) : null}
      {dialogRequest && (dialogRequest.mode !== "rename" || editing) && (dialogRequest.mode !== "move" || moving.length) ? (
        <FolderDialog
          key={`${dialogRequest.mode}:${dialogRequest.mode === "rename" ? dialogRequest.folderId : ""}`}
          mode={dialogRequest.mode}
          title={
            moving.length === 1
              ? t("workflowNav.moveItem", { title: moving[0].label })
              : t("workflowNav.moveSelected", { count: moving.length })
          }
          initialName={editing?.name}
          initialParentId={
            dialogRequest.mode === "create"
              ? (dialogRequest.parentId ?? "")
              : dialogRequest.mode === "rename"
                ? (editing?.parentId ?? "")
                : moving.length === 1
                  ? (moving[0].parentId ?? "")
                  : ""
          }
          choices={choices(
            dialogRequest.mode === "rename"
              ? editing?.id
              : moving.length === 1 && moving[0].kind === "folder"
                ? moving[0].id
                : undefined,
          )}
          busy={workflow.busy}
          error={workflow.error}
          onClose={closeFolderDialog}
          onSubmit={submitDialog}
        />
      ) : null}
      {folderMenu.menu}
      {shortcuts
        .filter((group) => group.ids.length)
        .map((group) => (
          <section key={group.label}>
            <div className="workflow-navigation-subheading">{group.label}</div>
            {group.ids
              .map((id) => entries.find((entry) => entry.kind === "session" && entry.id === id))
              .filter((entry): entry is TreeEntry => !!entry)
              .map(row)}
          </section>
        ))}
      <div
        className={`workflow-tree-root-target${drop?.key === "root" ? " is-drop-inside" : ""}`}
        onDragOver={(event) => over(event)}
        onDrop={(event) => {
          if (!dragging || !event.dataTransfer.types.includes(MIME)) return;
          event.preventDefault();
          event.stopPropagation();
          void move(dragging);
          setDragging(null);
          setDrop(null);
        }}
        aria-label={t("workflowNav.topLevel")}
      >
        {treeSiblings(entries)
          .filter((entry) => entry.kind === "folder" || !hiddenRootIds.includes(entry.id))
          .map(row)}
        <div className="workflow-tree-root-hint">
          {dragging ? t("workflowNav.dropAtRoot") : null}
        </div>
      </div>
    </section>
  );
}
