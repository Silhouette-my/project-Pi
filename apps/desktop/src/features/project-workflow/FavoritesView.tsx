import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectWorkflowSnapshot, SessionSummary } from "@pi-desktop/shared";
import { IconCube, IconStar } from "../../components/icons";
import { TooltipButton } from "../../components/ui";
import { useAppStore } from "../../stores/app-store";
import { favoriteProjects, favoriteSessions } from "./navigation-category-model";
import { useProjectWorkflow } from "./useProjectWorkflow";

type FavoriteProject = { id: string; name: string; order: number; archived?: boolean };

/**
 * The sidebar's Favorites view: favourited projects (cube row, not expandable;
 * the name opens project home) then favourited conversations from anywhere, with
 * the owning project as muted secondary text. Rows reuse the sidebar's own
 * session rows, so status dots and menus come with them.
 */
export function FavoritesView({
  snapshot,
  sessions,
  projects,
  projectNameOf,
  renderChat,
}: {
  snapshot: ProjectWorkflowSnapshot;
  sessions: SessionSummary[];
  projects: FavoriteProject[];
  projectNameOf: (session: SessionSummary) => string | undefined;
  renderChat: (session: SessionSummary) => ReactNode;
}) {
  const { t } = useTranslation();
  const workflow = useProjectWorkflow();
  const page = useAppStore((state) => state.page);
  const consoleId = useAppStore((state) => state.projectConsoleId);
  const setPage = useAppStore((state) => state.setPage);
  const starredProjects = favoriteProjects(snapshot, projects);
  const starredSessions = favoriteSessions(snapshot, sessions);
  const open = (projectId: string) => setPage("project", { projectId });
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
        {starredProjects.map((project) => {
          const home = page === "project" && consoleId === project.id;
          return (
            <div key={project.id} className="workflow-tree-node" data-workflow-tree-node={`project:${project.id}`}>
              <div className="workflow-tree-row sidebar-project-row" data-favorite-project={project.id}>
                <TooltipButton
                  type="button"
                  className={`sidebar-project-cube${home ? " is-active" : ""}`}
                  data-action="open-project-home"
                  tooltip={t("workflow.projectHome")}
                  ariaLabel={t("workflow.projectHome")}
                  aria-current={home ? "page" : undefined}
                  onClick={() => open(project.id)}
                >
                  <IconCube size={15} />
                </TooltipButton>
                <button type="button" className="sidebar-project-name project-toggle" onClick={() => open(project.id)}>
                  <span>{project.name}</span>
                </button>
                <div className="workflow-tree-actions">
                  <TooltipButton
                    type="button"
                    className="sidebar-row-action"
                    data-action="unfavorite-project"
                    tooltip={t("workflowNav.removeFavorite")}
                    ariaLabel={t("workflowNav.removeFavorite")}
                    disabled={workflow.busy}
                    onClick={() =>
                      void workflow.mutate({ kind: "project.favorite", projectId: project.id, favorite: false })
                    }
                  >
                    <IconStar size={13} />
                  </TooltipButton>
                </div>
              </div>
            </div>
          );
        })}
        {starredSessions.map((session) => {
          const origin = projectNameOf(session);
          return (
            <div key={session.id} className="workflow-tree-node" data-workflow-tree-node={`session:${session.id}`}>
              <div className="workflow-tree-row is-session">
                <div className="workflow-tree-content">{renderChat(session)}</div>
              </div>
              {origin ? <div className="sidebar-favorite-origin">{origin}</div> : null}
            </div>
          );
        })}
        {starredProjects.length + starredSessions.length === 0 ? (
          <div className="workflow-tree-empty">{t("workflowNav.noFavorites")}</div>
        ) : null}
      </div>
    </section>
  );
}
