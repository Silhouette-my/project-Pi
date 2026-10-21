import { useTranslation } from "react-i18next";
import { TooltipButton } from "../../components/ui";
import { IconChat } from "../../components/icons";
import { useProjectAgent } from "./useProjectAgent";

export function ProjectAgentButton({
  projectId,
  className,
}: {
  projectId: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const agent = useProjectAgent(projectId);
  return (
    <TooltipButton
      type="button"
      className={["workflow-agent-entry", className].filter(Boolean).join(" ")}
      tooltip={agent.error ?? t("workflow.agentTitle")}
      ariaLabel={t("workflow.agentTitle")}
      data-project-agent={projectId}
      aria-busy={agent.busy}
      disabled={agent.busy}
      onClick={(event) => {
        event.stopPropagation();
        void agent.open().catch(() => {});
      }}
    >
      <IconChat size={15} />
    </TooltipButton>
  );
}
