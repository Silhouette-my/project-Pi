import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectGroupRecord, SessionSummary } from "@pi-desktop/shared";
import { IconArrowUpDown, IconStar } from "../../components/icons";
import { sidebarMenuAction, type SidebarMenuActionItem } from "../../lib/sidebar-menu";
import { openFolderDialog } from "./folder-dialog-store";
import { workflowContextProjectId } from "./navigation-model";
import { sessionTreeContext } from "./navigation-tree-model";
import { useProjectWorkflow } from "./useProjectWorkflow";

/**
 * Organize actions for session row menus. Sidebar owns the menu surface; this
 * hook only supplies the rows that belong to the project workflow tree, so a
 * session outside any tree gets none.
 */
export function useWorkflowSessionMenu(groups: ProjectGroupRecord[]) {
  const { t } = useTranslation();
  const workflow = useProjectWorkflow();
  const snapshot = workflow.snapshot;
  const contextOf = useCallback(
    (session: SessionSummary) =>
      snapshot
        ? sessionTreeContext(snapshot, session, workflowContextProjectId(snapshot, groups, session))
        : undefined,
    [snapshot, groups],
  );

  const sessionItems = useCallback(
    (session: SessionSummary, onDone: () => void): SidebarMenuActionItem[] => {
      const context = contextOf(session);
      if (!snapshot || !context) return [];
      // Favourites mark standalone conversations only; project chats have no star.
      const record = snapshot.navigation.find((item) => item.sessionId === session.id) ?? {
        sessionId: session.id,
        order: 0,
        favorite: false,
      };
      const favorite =
        context.scope === "chats"
          ? [
              sidebarMenuAction({
                id: "toggle-session-favorite",
                label: record.favorite ? t("workflowNav.removeFavorite") : t("workflowNav.addFavorite"),
                icon: <IconStar size={14} />,
                disabled: workflow.busy,
                onSelect: () => {
                  onDone();
                  void workflow.mutate({
                    kind: "navigation.update",
                    navigation: { ...record, favorite: !record.favorite },
                  });
                },
              }),
            ]
          : [];
      const items = [
        ...favorite,
        sidebarMenuAction({
          id: "move-session-to-folder",
          label: t("workflowNav.moveToFolder"),
          icon: <IconArrowUpDown size={14} />,
          disabled: workflow.busy,
          onSelect: () => {
            onDone();
            openFolderDialog({ mode: "move", context, targets: [{ kind: "session", id: session.id }] });
          },
        }),
      ];
      return items;
    },
    [contextOf, snapshot, t, workflow],
  );

  /** Bulk move of a multi-selection, offered only when every chat shares one tree. */
  const batchItems = useCallback(
    (selected: SessionSummary[], onDone: () => void): SidebarMenuActionItem[] => {
      const contexts = selected.map(contextOf);
      const first = contexts[0];
      if (
        !first ||
        contexts.some((context) => context?.scope !== first.scope || context.projectId !== first.projectId)
      )
        return [];
      return [
        sidebarMenuAction({
          id: "batch-move-to-folder",
          label: t("workflowNav.moveToFolder"),
          icon: <IconArrowUpDown size={14} />,
          disabled: workflow.busy,
          onSelect: () => {
            onDone();
            openFolderDialog({
              mode: "move",
              context: first,
              targets: selected.map((session) => ({ kind: "session", id: session.id })),
            });
          },
        }),
      ];
    },
    [contextOf, t, workflow.busy],
  );

  return { sessionItems, batchItems };
}
