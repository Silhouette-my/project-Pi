import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { NavigationTree } from "./NavigationTree";
import { useProjectWorkflow } from "./useProjectWorkflow";

export function WorkflowProjectTree({
  projects,
}: {
  projects: {
    id: string;
    name: string;
    order: number;
    pinned?: boolean;
    archived?: boolean;
    render: ReactNode;
  }[];
}) {
  const { t } = useTranslation();
  const { snapshot } = useProjectWorkflow();
  const placements = new Map(
    (snapshot?.projectNavigation ?? []).map((row) => [row.projectId, row]),
  );
  return (
    <NavigationTree
      context={{ scope: "projects" }}
      label={t("nav.projects")}
      toolbar={false}
      entries={projects.map((project) => ({
        kind: "project",
        id: project.id,
        label: project.name,
        rank: project.archived ? 1 : project.pinned ? -1 : 0,
        parentId: placements.get(project.id)?.folderId,
        order: placements.get(project.id)?.order ?? project.order,
      }))}
      renderEntry={(entry) => projects.find((project) => project.id === entry.id)?.render}
    />
  );
}
