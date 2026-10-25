import { useState, type DragEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { WORKFLOW_CHATS_CATEGORY, WORKFLOW_PROJECTS_CATEGORY, type WorkflowFolder } from "@pi-desktop/shared";
import { Button, TooltipButton } from "../../components/ui";
import {
  IconChevronDown,
  IconArrowUpDown,
  IconClock,
  IconFolder,
  IconFolderOpen,
  IconMore,
  IconNewFolder,
  IconNewProject,
  IconNewSession,
  IconPencil,
  IconTrash,
} from "../../components/icons";
import { setSidebarGroupCollapsed, useSidebarCollapsedGroups } from "../../lib/sidebar-category-state";
import { sidebarMenuAction, type SidebarMenuPanelContent } from "../../lib/sidebar-menu";
import { openFolderDialog } from "./folder-dialog-store";
import { NavigationTreeDialog } from "./NavigationTreeDialog";
import { recentOrder } from "./navigation-category-model";
import { useRowMenu } from "./useRowMenu";
import { useProjectWorkflow } from "./useProjectWorkflow";
import {
  categoryRoot,
  dropPosition,
  folderCategory,
  folderDescendants,
  rootCategoryId,
  treeFolders,
  treePlacement,
  treeSiblings,
  type DropPosition,
  type TreeContext,
  type TreeEntry,
} from "./navigation-tree-model";
import "./navigation-styles.css";

const MIME = "application/x-pi-navigation-tree";
const RECENT_GROUP = "recent";

export type NavigationCategory = { id: string; name: string; builtin: boolean };
type Props = {
  context: TreeContext;
  entries: TreeEntry[];
  renderEntry: (entry: TreeEntry) => ReactNode;
  label: string;
  /** Category mode: the sidebar's sections. Absent for a project's own tree. */
  categories?: NavigationCategory[];
  /** New conversation inside a folder or at a category's top level. */
  onNewChat?: (where: { folderId?: string; categoryId?: string }) => void;
  newChatDisabled?: boolean;
  /** Add-project flow, offered on the Projects category header. */
  onNewProject?: () => void;
};

/**
 * One tree for a whole navigation space. In category mode it renders every
 * category (header, folders, projects, conversations mixed freely); inside a
 * project it renders that project's folders and conversations. The Host owns
 * placement; local state only describes the current drag gesture.
 */
export function NavigationTree({
  context,
  entries: leaves,
  renderEntry,
  label,
  categories,
  onNewChat,
  newChatDisabled,
  onNewProject,
}: Props) {
  const { t } = useTranslation();
  const workflow = useProjectWorkflow();
  const snapshot = workflow.snapshot;
  const collapsedGroups = useSidebarCollapsedGroups();
  const [dragging, setDragging] = useState<TreeEntry | null>(null);
  const [drop, setDrop] = useState<{ key: string; position: DropPosition } | null>(null);
  const folders = snapshot ? treeFolders(snapshot, context) : [];
  const parentOf = (folder: WorkflowFolder) =>
    folder.parentId ?? (categories ? categoryRoot(folderCategory(folder)) : undefined);

  const folderMenu = useRowMenu((id): SidebarMenuPanelContent | null => {
    const folder = folders.find((item) => item.id === id);
    if (!folder) return null;
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
          id: "new-subfolder",
          label: t("workflowNav.newFolder"),
          icon: <IconNewFolder size={14} />,
          onSelect: () => {
            folderMenu.close(false);
            openFolderDialog({ mode: "create", context, parentId: folder.id });
          },
        }),
        // The keyboard path for relocating a folder; dragging stays the pointer path.
        sidebarMenuAction({
          id: "move-folder",
          label: t("workflowNav.moveTo"),
          icon: <IconArrowUpDown size={14} />,
          disabled: workflow.busy,
          onSelect: () => {
            folderMenu.close(false);
            openFolderDialog({ mode: "move", context, targets: [{ kind: "folder", id: folder.id }] });
          },
        }),
        // Never deletes conversations: children move up one level.
        sidebarMenuAction({
          id: "remove-folder",
          label: t("workflowNav.removeFolder"),
          icon: <IconTrash size={14} />,
          disabled: workflow.busy,
          onSelect: () => {
            folderMenu.close(false);
            void workflow.mutate({ kind: "folder.remove", folderId: folder.id });
          },
        }),
      ],
    };
  });
  const categoryMenu = useRowMenu((id): SidebarMenuPanelContent | null => {
    const category = categories?.find((item) => item.id === id && !item.builtin);
    if (!category) return null;
    return {
      label: t("workflowNav.categoryActions"),
      items: [
        sidebarMenuAction({
          id: "rename-category",
          label: t("workflowNav.renameCategory"),
          icon: <IconPencil size={14} />,
          onSelect: () => {
            categoryMenu.close(false);
            openFolderDialog({ mode: "category-rename", context, categoryId: category.id });
          },
        }),
        // No confirmation: contents fall back to the built-in categories.
        sidebarMenuAction({
          id: "delete-category",
          label: t("workflowNav.deleteCategory"),
          icon: <IconTrash size={14} />,
          disabled: workflow.busy,
          onSelect: () => {
            categoryMenu.close(false);
            void workflow.mutate({ kind: "category.remove", categoryId: category.id });
          },
        }),
      ],
    };
  });
  if (!snapshot) return <>{leaves.map(renderEntry)}</>;

  const entries: TreeEntry[] = [
    ...leaves,
    ...folders.map((folder) => ({
      kind: "folder" as const,
      id: folder.id,
      label: folder.name,
      parentId: parentOf(folder),
      order: folder.order,
    })),
  ];
  const key = (entry: TreeEntry) => `${entry.kind}:${entry.id}`;
  const toggleFolder = (id: string) =>
    workflow.mutate({
      kind: "navigation.expand",
      expandedIds: snapshot.expandedIds.includes(id)
        ? snapshot.expandedIds.filter((item) => item !== id)
        : [...snapshot.expandedIds, id],
    });

  /** Resolves false only when the Host rejected the move; a no-op counts as done. */
  async function move(
    source: TreeEntry,
    target?: TreeEntry,
    position: DropPosition = "after",
    rootId?: string,
  ) {
    const placement = treePlacement(entries, source, target, position, rootId);
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
    const category = rootCategoryId(placement.folderId);
    const result = await workflow.mutate({
      kind: "tree.move",
      target: { kind: source.kind, id: source.id },
      scope: context.scope,
      projectId: context.projectId,
      folderId: category ? undefined : placement.folderId,
      categoryId: category,
      order: placement.order,
      siblingOrder,
    });
    if (
      result &&
      placement.folderId &&
      !category &&
      !result.snapshot.expandedIds.includes(placement.folderId)
    ) {
      await workflow.mutate({
        kind: "navigation.expand",
        expandedIds: [...result.snapshot.expandedIds, placement.folderId],
      });
    }
    return !!result;
  }
  function over(event: DragEvent, entry?: TreeEntry, rootId?: string, dropKey?: string) {
    if (!dragging || !event.dataTransfer.types.includes(MIME)) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const position = entry
      ? dropPosition(entry.kind, (event.clientY - rect.top) / rect.height)
      : "inside";
    const placement = treePlacement(entries, dragging, entry, entry ? position : "after", rootId);
    event.dataTransfer.dropEffect = placement ? "move" : "none";
    setDrop(placement ? { key: dropKey ?? (entry ? key(entry) : "root"), position } : null);
  }
  function dropOn(event: DragEvent, entry?: TreeEntry, rootId?: string, dropKey?: string) {
    if (!dragging || !event.dataTransfer.types.includes(MIME)) return;
    event.preventDefault();
    event.stopPropagation();
    const expected = dropKey ?? (entry ? key(entry) : "root");
    const position = drop?.key === expected ? drop.position : "after";
    void move(dragging, entry, entry ? position : "after", rootId);
    setDragging(null);
    setDrop(null);
  }

  const actionButton = (
    tooltip: string,
    icon: ReactNode,
    onClick: () => void,
    extra?: { disabled?: boolean; action?: string },
  ) => (
    <TooltipButton
      type="button"
      className="sidebar-row-action"
      data-action={extra?.action}
      tooltip={tooltip}
      ariaLabel={tooltip}
      disabled={extra?.disabled}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      {icon}
    </TooltipButton>
  );
  const moreButton = (
    tooltip: string,
    action: string,
    menu: { openId?: string; open: (id: string, anchor: HTMLElement | null) => void; close: () => void },
    id: string,
  ) => (
    <TooltipButton
      type="button"
      className="sidebar-row-action thread-item-more"
      data-action={action}
      tooltip={tooltip}
      ariaLabel={tooltip}
      aria-haspopup="menu"
      aria-expanded={menu.openId === id}
      onClick={(event) => {
        event.stopPropagation();
        if (menu.openId === id) menu.close();
        else menu.open(id, event.currentTarget);
      }}
    >
      <IconMore size={14} />
    </TooltipButton>
  );

  function row(entry: TreeEntry, nested: boolean, asRoot?: string): ReactNode {
    const folder =
      entry.kind === "folder" ? folders.find((item) => item.id === entry.id) : undefined;
    const open = folder ? snapshot!.expandedIds.includes(folder.id) : false;
    // Only a category's own folders and projects are shaded blocks; inside a
    // project the folders sit flat in the project's block.
    const block = !!categories && !nested && (folder ? open : entry.kind === "project" && !!entry.open);
    const nestedEntries = folder && open ? treeSiblings(entries, folder.id) : [];
    return (
      <div
        key={key(entry)}
        className={`workflow-tree-node${block ? " is-block" : ""}${dragging && key(dragging) === key(entry) ? " is-dragging" : ""}`}
        data-workflow-tree-node={key(entry)}
        data-workflow-folder={folder?.id}
      >
        <div
          className={`workflow-tree-row${folder ? " is-folder" : ""}${entry.kind === "session" ? " is-session" : ""}${drop?.key === key(entry) ? ` is-drop-${drop.position}` : ""}${folder && folderMenu.openId === folder.id ? " is-menu-open" : ""}`}
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
          onDragOver={(event) => (asRoot ? over(event, undefined, asRoot, key(entry)) : over(event, entry))}
          onDrop={(event) => (asRoot ? dropOn(event, undefined, asRoot, key(entry)) : dropOn(event, entry))}
        >
          {folder ? (
            <>
              <Button
                variant="ghost"
                className="workflow-navigation-label workflow-tree-folder"
                aria-expanded={open}
                onClick={() => void toggleFolder(folder.id)}
              >
                {open ? <IconFolderOpen size={16} /> : <IconFolder size={16} />}
                <span>{folder.name}</span>
              </Button>
              <div className="workflow-tree-actions">
                {onNewChat
                  ? actionButton(t("workflowNav.newChat"), <IconNewSession size={13} />, () =>
                      onNewChat({ folderId: folder.id }), { disabled: newChatDisabled || workflow.busy })
                  : null}
                {actionButton(t("workflowNav.newFolder"), <IconNewFolder size={13} />, () =>
                  openFolderDialog({ mode: "create", context, parentId: folder.id }))}
                {moreButton(t("workflowNav.folderActions"), "folder-menu", folderMenu, folder.id)}
              </div>
            </>
          ) : (
            <div className="workflow-tree-content">{renderEntry(entry)}</div>
          )}
        </div>
        {folder && open ? (
          <div className="workflow-tree-children">
            {nestedEntries.map((child) => row(child, true))}
            {nestedEntries.length === 0 ? (
              <div className="workflow-tree-empty">{t("workflowNav.emptyFolder")}</div>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  function categoryBlock(category: NavigationCategory) {
    const groupId = `category:${category.id}`;
    const open = !collapsedGroups.has(groupId);
    const rootKey = categoryRoot(category.id);
    const root = treeSiblings(entries, rootKey);
    const isChats = category.id === WORKFLOW_CHATS_CATEGORY;
    const isProjects = category.id === WORKFLOW_PROJECTS_CATEGORY;
    const top = isChats ? root.filter((entry) => entry.kind !== "session") : root;
    const recent = isChats ? recentOrder(root.filter((entry) => entry.kind === "session")) : [];
    const recentOpen = !collapsedGroups.has(RECENT_GROUP);
    const toggleLabel = open ? t("workflowNav.collapse") : t("workflowNav.expand");
    return (
      <section
        key={category.id}
        className="sidebar-category"
        data-sidebar-category={category.id}
        aria-label={category.name}
      >
        <div
          className={`sidebar-category-header${drop?.key === groupId ? " is-drop-inside" : ""}${categoryMenu.openId === category.id ? " is-menu-open" : ""}`}
          onClick={() => setSidebarGroupCollapsed(groupId, open)}
          onContextMenu={(event) => {
            if (category.builtin) return;
            event.preventDefault();
            event.stopPropagation();
            categoryMenu.open(category.id, null, { x: event.clientX, y: event.clientY });
          }}
          onDragOver={(event) => over(event, undefined, rootKey, groupId)}
          onDrop={(event) => dropOn(event, undefined, rootKey, groupId)}
        >
          <span className="sidebar-category-title">{category.name}</span>
          <button
            type="button"
            className="sidebar-category-chevron"
            aria-expanded={open}
            aria-label={toggleLabel}
            title={toggleLabel}
            onClick={(event) => {
              event.stopPropagation();
              setSidebarGroupCollapsed(groupId, open);
            }}
          >
            <IconChevronDown size={11} className={open ? "" : "workflow-navigation-folded"} />
          </button>
          <span className="sidebar-category-spacer" />
          <div className="sidebar-category-actions">
            {isProjects
              ? onNewProject
                ? actionButton(t("nav.newProject"), <IconNewProject size={14} />, onNewProject, {
                    action: "new-project",
                  })
                : null
              : onNewChat
                ? actionButton(t("workflowNav.newChat"), <IconNewSession size={14} />, () =>
                    onNewChat({ categoryId: category.id }), {
                    disabled: newChatDisabled || workflow.busy,
                    action: "category-new-chat",
                  })
                : null}
            {actionButton(t("workflowNav.newFolder"), <IconNewFolder size={14} />, () =>
              openFolderDialog({ mode: "create", context, parentId: rootKey }), {
              action: "category-new-folder",
            })}
            {category.builtin
              ? null
              : moreButton(t("workflowNav.categoryActions"), "category-menu", categoryMenu, category.id)}
          </div>
        </div>
        {open ? (
          <div
            className={`sidebar-category-body${drop?.key === groupId ? " is-drop-inside" : ""}`}
            onDragOver={(event) => over(event, undefined, rootKey, groupId)}
            onDrop={(event) => dropOn(event, undefined, rootKey, groupId)}
          >
            {top.map((entry) => row(entry, false))}
            {isChats ? (
              <>
                <div
                  className={`workflow-tree-row is-recent-row${drop?.key === RECENT_GROUP ? " is-drop-inside" : ""}`}
                  onClick={() => setSidebarGroupCollapsed(RECENT_GROUP, recentOpen)}
                  onDragOver={(event) => over(event, undefined, rootKey, RECENT_GROUP)}
                  onDrop={(event) => dropOn(event, undefined, rootKey, RECENT_GROUP)}
                >
                  <Button
                    variant="ghost"
                    className="workflow-navigation-label workflow-tree-folder"
                    aria-expanded={recentOpen}
                    onClick={(event) => {
                      event.stopPropagation();
                      setSidebarGroupCollapsed(RECENT_GROUP, recentOpen);
                    }}
                  >
                    <IconClock size={16} />
                    <span>{t("workflowNav.recent")}</span>
                  </Button>
                </div>
                {recentOpen ? (
                  <div className="workflow-tree-children">
                    {recent.map((entry) => row(entry, true, rootKey))}
                    {recent.length === 0 ? (
                      <div className="workflow-tree-empty">{t("workflowNav.noChats")}</div>
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : null}
            {!isChats && top.length === 0 ? (
              <div className="workflow-tree-empty">{t("workflowNav.emptyCategory")}</div>
            ) : null}
          </div>
        ) : null}
      </section>
    );
  }

  return (
    <section
      className="workflow-navigation-tree"
      aria-label={label}
      data-workflow-tree={context.scope}
      data-project-id={context.projectId}
    >
      {workflow.error ? (
        <p role="alert" className="workflow-navigation-error">
          {workflow.error}
        </p>
      ) : null}
      <NavigationTreeDialog
        context={context}
        entries={entries}
        folders={folders}
        categories={categories}
        move={move}
      />
      {folderMenu.menu}
      {categoryMenu.menu}
      {categories ? (
        categories.map(categoryBlock)
      ) : (
        <div
          className={`workflow-tree-root-target${drop?.key === "root" ? " is-drop-inside" : ""}`}
          onDragOver={(event) => over(event)}
          onDrop={(event) => dropOn(event)}
          aria-label={t("workflowNav.topLevel")}
        >
          {treeSiblings(entries).map((entry) => row(entry, false))}
          <div className="workflow-tree-root-hint">
            {dragging ? t("workflowNav.dropAtRoot") : null}
          </div>
        </div>
      )}
    </section>
  );
}

export { folderDescendants };
