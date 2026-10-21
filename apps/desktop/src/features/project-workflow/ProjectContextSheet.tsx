import { useTranslation } from "react-i18next";
import type { WorkflowWorkstream } from "@pi-desktop/shared";
import { Field, Select, TooltipButton } from "../../components/ui";
import { IconBookOpen, IconClose } from "../../components/icons";
import { projectAccentStyle } from "../../lib/project-accent";
import { WorkflowContext } from "./WorkflowContext";
import { WorkstreamEditorDialog } from "./WorkstreamEditorDialog";

/**
 * Shared context (canonical references and decisions) as a header sheet rather
 * than a console tab: it applies across workstreams, so it is reached from the
 * project header and scoped by the same workstream filter as before.
 */
export function ProjectContextSheet({
  projectId,
  workstreams,
  workstreamId,
  onWorkstreamChange,
  onOpenReference,
  onClose,
  color,
}: {
  projectId: string;
  workstreams: WorkflowWorkstream[];
  workstreamId: string;
  onWorkstreamChange: (id: string) => void;
  onOpenReference: (reference: { kind: "artifact" | "resource"; id: string }) => Promise<void>;
  onClose: () => void;
  /** The project's colour id, when it has one. */
  color?: string;
}) {
  const { t } = useTranslation();
  return (
    <WorkstreamEditorDialog
      onClose={onClose}
      labelledBy="workflow-context-sheet-title"
      className="workflow-context-sheet"
      style={projectAccentStyle(color)}
      dataProjectColor={color}
    >
      <div className="workflow-context-sheet-head">
        <span className="workflow-context-sheet-glyph" aria-hidden="true">
          <IconBookOpen size={16} />
        </span>
        <div>
          <h3 id="workflow-context-sheet-title">{t("workflow.context")}</h3>
          <p className="workflow-muted">{t("workflow.contextSheetDescription")}</p>
        </div>
        <TooltipButton
          className="ct-icon-btn"
          tooltip={t("workflow.closeContext")}
          ariaLabel={t("workflow.closeContext")}
          onClick={onClose}
        >
          <IconClose size={15} />
        </TooltipButton>
      </div>
      <div className="workflow-context-sheet-body" data-workflow-context-sheet={projectId}>
        <div className="project-structure-filters">
          <Field label={t("workflow.chooseWorkstream")}>
            <Select value={workstreamId} onChange={(event) => onWorkstreamChange(event.target.value)}>
              <option value="">{t("workflow.allWorkstreams")}</option>
              {workstreams.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <WorkflowContext
          projectId={projectId}
          workstreamId={workstreamId || undefined}
          onOpenReference={onOpenReference}
        />
      </div>
    </WorkstreamEditorDialog>
  );
}
