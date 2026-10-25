import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { SessionSummary, WorkflowNavigation as NavigationRecord } from "@pi-desktop/shared";
import { useAppStore } from "../../stores/app-store";
import { NavigationTree } from "./NavigationTree";
import { categoryLeaves, favoriteSessions, sidebarCategories, standaloneSessions } from "./navigation-category-model";
import { useSidebarListView } from "../../lib/sidebar-view-state";
import { useProjectWorkflow } from "./useProjectWorkflow";
import "./navigation-styles.css";

export type CategoryProject = {
  id: string;
  name: string;
  order: number;
  pinned?: boolean;
  archived?: boolean;
  /** Body expanded: the row is a shaded block. */
  open: boolean;
  render: ReactNode;
};

type Props = {
  sessions: SessionSummary[];
  pinnedSessionIds: ReadonlySet<string>;
  renderSessions: (sessions: SessionSummary[]) => ReactNode;
  projects: CategoryProject[];
  onNewProject: () => void;
};

/**
 * Every sidebar category in one tree: built-in Chats and Projects plus the
 * user's own. A category mixes folders, standalone conversations and projects;
 * the Host snapshot decides where each sits.
 */
export function CategoryNavigation({
  sessions,
  pinnedSessionIds,
  renderSessions,
  projects,
  onNewProject,
}: Props) {
  const workflow = useProjectWorkflow();
  const { t } = useTranslation();
  const view = useSidebarListView();
  const [creating, setCreating] = useState(false);
  const [creationError, setCreationError] = useState<string | null>(null);
  const snapshot = workflow.snapshot;
  const categories = useMemo(
    () => (snapshot ? sidebarCategories(snapshot, { chats: t("workflowNav.chats"), projects: t("nav.projects") }) : []),
    [snapshot, t],
  );
  if (!snapshot) return null;
  const standalone = standaloneSessions(snapshot, sessions);
  const nav = new Map(snapshot.navigation.map((item) => [item.sessionId, item]));
  const record = (sessionId: string): NavigationRecord =>
    nav.get(sessionId) ?? { sessionId, order: 0, favorite: false };
  const leaves = categoryLeaves(snapshot, standalone, projects, pinnedSessionIds);

  async function newChat(where: { folderId?: string; categoryId?: string }) {
    setCreating(true);
    setCreationError(null);
    try {
      const sessionId = await useAppStore.getState().newSession({ projectPath: null });
      if (sessionId)
        await workflow.mutate({ kind: "navigation.move", sessionIds: [sessionId], ...where });
    } catch (cause) {
      setCreationError(
        t("workflow.requestFailed", {
          detail: cause instanceof Error ? cause.message : String(cause),
        }),
      );
    } finally {
      setCreating(false);
    }
  }
  function renderChat(session: SessionSummary) {
    return (
      <div
        key={session.id}
        className="workflow-navigation-chat"
        onClickCapture={(event) => {
          if ((event.target as Element).closest(".thread-item-main"))
            void workflow.mutate({
              kind: "navigation.update",
              navigation: { ...record(session.id), lastAccessedAt: new Date().toISOString() },
            });
        }}
      >
        <div className="workflow-navigation-session">{renderSessions([session])}</div>
      </div>
    );
  }
  if (view === "favorites") {
    const favorites = favoriteSessions(snapshot, sessions);
    return (
      <section
        className="workflow-navigation sidebar-favorites"
        aria-label={t("workflowNav.favorites")}
        data-sidebar-view="favorites"
      >
        <div className="sidebar-category-header sidebar-favorites-header">
          <span className="sidebar-category-title">{t("workflowNav.favorites")}</span>
        </div>
        <div className="sidebar-category-body">
          {favorites.map((session) => (
            <div key={session.id} className="workflow-tree-node" data-workflow-tree-node={`session:${session.id}`}>
              <div className="workflow-tree-row is-session">
                <div className="workflow-tree-content">{renderChat(session)}</div>
              </div>
            </div>
          ))}
          {favorites.length === 0 ? (
            <div className="workflow-tree-empty">{t("workflowNav.noFavorites")}</div>
          ) : null}
        </div>
      </section>
    );
  }
  return (
    <section className="workflow-navigation" aria-label={t("workflowNav.chats")}>
      {creationError ? (
        <p role="alert" className="workflow-navigation-error">
          {creationError}
        </p>
      ) : null}
      <NavigationTree
        context={{ scope: "chats" }}
        label={t("workflowNav.chats")}
        categories={categories}
        entries={leaves}
        newChatDisabled={creating}
        onNewChat={(where) => void newChat(where)}
        onNewProject={onNewProject}
        renderEntry={(entry) => {
          if (entry.kind === "project") return projects.find((project) => project.id === entry.id)?.render;
          const session = standalone.find((item) => item.id === entry.id);
          return session ? renderChat(session) : null;
        }}
      />
    </section>
  );
}
