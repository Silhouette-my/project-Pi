import { useState, type DragEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { WorkflowFolder } from "@pi-desktop/shared";
import { Button, Field, Input, Select, TooltipButton } from "../../components/ui";
import { IconChevronDown, IconFolder, IconPencil, IconTrash } from "../../components/icons";
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
  toolbar?: boolean;
  manage?: boolean;
  onManageChange?: (manage: boolean) => void;
  toolbarActions?: ReactNode;
  beforeTree?: ReactNode;
  shortcuts?: { label: string; ids: string[] }[];
  hiddenRootIds?: string[];
  renderFolderActions?: (folder: WorkflowFolder) => ReactNode;
};
/** The Host owns placement; local state only describes the current gesture/editor. */
export function NavigationTree({
  context,
  entries: leaves,
  renderEntry,
  label,
  toolbar = true,
  manage: controlledManage,
  onManageChange,
  toolbarActions,
  beforeTree,
  shortcuts = [],
  hiddenRootIds = [],
  renderFolderActions,
}: Props) {
  const { t } = useTranslation();
  const workflow = useProjectWorkflow();
  const [localManage, setLocalManage] = useState(false);
  const manage = controlledManage ?? localManage;
  const setManage = onManageChange ?? setLocalManage;
  const [editor, setEditor] = useState<{
    folder?: WorkflowFolder;
    name: string;
    parentId: string;
  } | null>(null);
  const [moving, setMoving] = useState<TreeEntry | null>(null);
  const [destination, setDestination] = useState("");
  const [removeId, setRemoveId] = useState<string | null>(null);
  const [dragging, setDragging] = useState<TreeEntry | null>(null);
  const [drop, setDrop] = useState<{ key: string; position: DropPosition } | null>(null);
  const snapshot = workflow.snapshot;
  if (!snapshot) return <>{leaves.map(renderEntry)}</>;
  const folders = treeFolders(snapshot, context);
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
  const choices = (id?: string) => folders.filter((folder) => !forbidden(id).has(folder.id));
  const toggle = (id: string) =>
    workflow.mutate({
      kind: "navigation.expand",
      expandedIds: snapshot.expandedIds.includes(id)
        ? snapshot.expandedIds.filter((item) => item !== id)
        : [...snapshot.expandedIds, id],
    });
  async function move(source: TreeEntry, target?: TreeEntry, position: DropPosition = "after") {
    const placement = treePlacement(entries, source, target, position);
    if (!placement) return;
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
    if (result) setMoving(null);
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
  async function saveFolder() {
    if (!editor?.name.trim()) return;
    const folder: WorkflowFolder = {
      ...editor.folder,
      id: editor.folder?.id ?? crypto.randomUUID(),
      name: editor.name.trim(),
      parentId: editor.parentId || undefined,
      order:
        editor.folder?.order ??
        Math.max(
          -1,
          ...treeSiblings(entries, editor.parentId || undefined).map((entry) => entry.order),
        ) + 1,
      ...context,
    };
    if (await workflow.mutate({ kind: editor.folder ? "folder.update" : "folder.create", folder }))
      setEditor(null);
  }
  function row(entry: TreeEntry): ReactNode {
    const folder =
      entry.kind === "folder" ? folders.find((folder) => folder.id === entry.id)! : undefined;
    const open = snapshot!.expandedIds.includes(entry.id);
    return (
      <div
        key={key(entry)}
        className={`workflow-tree-node${dragging && key(dragging) === key(entry) ? " is-dragging" : ""}`}
        data-workflow-tree-node={key(entry)}
        data-workflow-folder={folder?.id}
      >
        <div
          className={`workflow-tree-row${drop?.key === key(entry) ? ` is-drop-${drop.position}` : ""}`}
          draggable={!workflow.busy}
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
          {folder ? renderFolderActions?.(folder) : null}
          {manage ? (
            <div className="workflow-tree-controls">
              <TooltipButton
                className="sidebar-toolbar-button"
                tooltip={t("workflowNav.move")}
                ariaLabel={t("workflowNav.move")}
                disabled={workflow.busy}
                onClick={() => {
                  setMoving(entry);
                  setDestination(entry.parentId ?? "");
                }}
              >
                ↕
              </TooltipButton>
              {folder ? (
                <>
                  <TooltipButton
                    className="sidebar-toolbar-button"
                    tooltip={t("workflowNav.editFolder")}
                    ariaLabel={t("workflowNav.editFolder")}
                    onClick={() =>
                      setEditor({ folder, name: folder.name, parentId: folder.parentId ?? "" })
                    }
                  >
                    <IconPencil size={12} />
                  </TooltipButton>
                  <TooltipButton
                    className="sidebar-toolbar-button"
                    tooltip={t("workflowNav.removeFolder")}
                    ariaLabel={t("workflowNav.removeFolder")}
                    onClick={() => setRemoveId(folder.id)}
                  >
                    <IconTrash size={12} />
                  </TooltipButton>
                </>
              ) : null}
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
      <div className="workflow-tree-toolbar">
        <span>{toolbar ? label : null}</span>
        <div className="sidebar-toolbar-actions">
          {toolbarActions}
          <TooltipButton
            className="sidebar-toolbar-button"
            tooltip={t("workflowNav.newFolder")}
            ariaLabel={t("workflowNav.newFolder")}
            onClick={() => setEditor({ name: "", parentId: "" })}
          >
            <IconFolder size={13} />
          </TooltipButton>
          <TooltipButton
            className="sidebar-toolbar-button"
            tooltip={t("workflowNav.organize")}
            ariaLabel={t("workflowNav.organize")}
            aria-pressed={manage}
            onClick={() => setManage(!manage)}
          >
            <IconPencil size={13} />
          </TooltipButton>
        </div>
      </div>
      {workflow.error ? (
        <p role="alert" className="workflow-navigation-error">
          {workflow.error}
        </p>
      ) : null}
      {editor ? (
        <form
          className="workflow-navigation-editor"
          onSubmit={(event) => {
            event.preventDefault();
            void saveFolder();
          }}
        >
          <Field label={t("workflowNav.folderName")}>
            <Input
              autoFocus
              value={editor.name}
              onChange={(event) => setEditor({ ...editor, name: event.target.value })}
            />
          </Field>
          <Field label={t("workflowNav.parentFolder")}>
            <Select
              value={editor.parentId}
              onChange={(event) => setEditor({ ...editor, parentId: event.target.value })}
            >
              <option value="">{t("workflowNav.topLevel")}</option>
              {choices(editor.folder?.id).map((folder) => (
                <option key={folder.id} value={folder.id}>
                  {folderPath(folders, folder)}
                </option>
              ))}
            </Select>
          </Field>
          <div className="workflow-navigation-actions">
            <Button type="submit" disabled={workflow.busy || !editor.name.trim()}>
              {t("common.save")}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setEditor(null)}>
              {t("common.cancel")}
            </Button>
          </div>
        </form>
      ) : null}
      {moving ? (
        <div className="workflow-navigation-editor">
          <Field label={t("workflowNav.moveItem", { title: moving.label })}>
            <Select value={destination} onChange={(event) => setDestination(event.target.value)}>
              <option value="">{t("workflowNav.topLevel")}</option>
              {choices(moving.kind === "folder" ? moving.id : undefined).map((folder) => (
                <option key={folder.id} value={folder.id}>
                  {folderPath(folders, folder)}
                </option>
              ))}
            </Select>
          </Field>
          <div className="workflow-navigation-actions">
            <Button
              disabled={workflow.busy}
              onClick={() =>
                void move(
                  moving,
                  destination
                    ? entries.find((entry) => entry.kind === "folder" && entry.id === destination)
                    : undefined,
                  destination ? "inside" : "after",
                )
              }
            >
              {t("workflowNav.move")}
            </Button>
            <Button
              variant="ghost"
              disabled={workflow.busy}
              onClick={() => {
                const siblings = treeSiblings(entries, destination || undefined).filter(
                  (entry) => key(entry) !== key(moving) && (entry.rank ?? 0) === (moving.rank ?? 0),
                );
                void move(moving, siblings[0], "before");
              }}
            >
              {t("workflowNav.moveFirst")}
            </Button>
            <Button variant="ghost" onClick={() => setMoving(null)}>
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      ) : null}
      {removeId ? (
        <div className="workflow-navigation-editor" role="alert">
          <p>{t("workflowNav.removeHint")}</p>
          <Button
            disabled={workflow.busy}
            onClick={async () => {
              if (await workflow.mutate({ kind: "folder.remove", folderId: removeId }))
                setRemoveId(null);
            }}
          >
            {t("workflowNav.removeFolder")}
          </Button>
          <Button variant="ghost" onClick={() => setRemoveId(null)}>
            {t("common.cancel")}
          </Button>
        </div>
      ) : null}
      {beforeTree}
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
