import { useTranslation } from "react-i18next";
import { TooltipButton } from "../../components/ui";
import { IconChat } from "../../components/icons";
import { useProjectAgent } from "./useProjectAgent";
import { useAppStore } from "../../stores/app-store";

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
        void agent.open().catch((cause: unknown) => {
          useAppStore
            .getState()
            .showToast(cause instanceof Error ? cause.message : String(cause), {
              variant: "error",
            });
        });
      }}
    >
      <IconChat size={15} />
    </TooltipButton>
  );
}
