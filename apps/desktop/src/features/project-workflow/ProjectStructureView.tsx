import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectWorkflowSnapshot } from "@pi-desktop/shared";
import { SegmentedControl } from "../../components/ui";
import { SessionStructureView } from "./SessionStructureView";
import { GitStructureView } from "./GitStructureView";
import { ArchitectureStructureView } from "./ArchitectureStructureView";

export function ProjectStructureView(props: {
  projectId: string;
  snapshot: ProjectWorkflowSnapshot;
  projectPaths: string[];
  onOpenSession: (id: string) => Promise<void>;
  onOpenWorkstream: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [view, setView] = useState("sessions");
  return (
    <section className="project-structure" data-project-structure-view={view}>
      <div className="project-structure-heading">
        <div>
          <h2>{t("projectStructure.structure")}</h2>
          <p>{t(`projectStructure.descriptions.${view}`)}</p>
        </div>
        <SegmentedControl
          value={view}
          onChange={setView}
          label={t("projectStructure.structure")}
          options={["sessions", "git", "architecture"].map((value) => ({
            value,
            label: t(`projectStructure.${value}`),
          }))}
        />
      </div>
      {view === "sessions" ? (
        <SessionStructureView {...props} />
      ) : view === "git" ? (
        <GitStructureView projectId={props.projectId} />
      ) : (
        <ArchitectureStructureView projectId={props.projectId} />
      )}
    </section>
  );
}
