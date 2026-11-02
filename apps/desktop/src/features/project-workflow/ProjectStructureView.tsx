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
  // The switcher leads each view's single toolbar row; its description is the tooltip.
  const switcher = (
    <span className="project-structure-heading" title={t(`projectStructure.descriptions.${view}`)}>
      <SegmentedControl
        value={view}
        onChange={setView}
        label={t("projectStructure.structure")}
        options={["sessions", "git", "architecture"].map((value) => ({
          value,
          label: t(`projectStructure.${value}`),
        }))}
      />
    </span>
  );
  return (
    <section className="project-structure" data-project-structure-view={view}>
      {view === "sessions" ? (
        <SessionStructureView {...props} switcher={switcher} />
      ) : view === "git" ? (
        <GitStructureView projectId={props.projectId} switcher={switcher} />
      ) : (
        <ArchitectureStructureView projectId={props.projectId} switcher={switcher} />
      )}
    </section>
  );
}
