import { useTranslation } from "react-i18next";
import type { WorkflowStatus } from "@pi-desktop/shared";
import { Badge } from "../../components/ui";
import { workflowStatusTone } from "./workflow-status-tone";

/** Workstream status in the shared semantic vocabulary (07 §12.2). */
export function WorkflowStatusBadge({ status }: { status: WorkflowStatus }) {
  const { t } = useTranslation();
  const tone = workflowStatusTone(status);
  return (
    <Badge
      tone={tone === "decision" || tone === "muted" ? "neutral" : tone}
      className={`workflow-status-badge is-${tone}`}
    >
      {t(`workflow.status.${status}`)}
    </Badge>
  );
}
