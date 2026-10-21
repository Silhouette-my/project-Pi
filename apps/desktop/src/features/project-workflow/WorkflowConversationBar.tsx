import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui";
import { useAppStore } from "../../stores/app-store";
import { useProjectWorkflow } from "./useProjectWorkflow";
import "./workflow.css";

export function WorkflowConversationBar() {
  const { t } = useTranslation();
  const { snapshot } = useProjectWorkflow();
  const sessionId = useAppStore((state) => state.activeSessionId);
  const setPage = useAppStore((state) => state.setPage);
  const projectAgent = snapshot?.projectAgents?.find((item) => item.sessionId === sessionId);
  const link = snapshot?.conversations.find((item) => item.sessionId === sessionId);
  const workstream = snapshot?.workstreams.find((item) => item.id === link?.workstreamId);
  if (projectAgent) {
    return (
      <aside className="workflow-conversation-bar" aria-label={t("workflow.agentTitle")}>
        <div>
          <strong>{t("workflow.agentTitle")}</strong>
          <span>{t("workflow.agentDiscussionHint")}</span>
        </div>
        <Button size="sm" onClick={() => setPage("project", { projectId: projectAgent.projectId })}>
          {t("workflow.backToConsole")}
        </Button>
      </aside>
    );
  }
  if (!link || !workstream) return null;
  return (
    <aside className="workflow-conversation-bar" aria-label={t("workflow.controls")}>
      <div>
        <strong>{workstream.title}</strong>
        <span>
          {t("workflow.conversationRole", {
            purpose: t(`workflow.purposes.${link.purpose}`),
            visibility: t(
              link.visibility === "side_only" ? "workflow.sideOnly" : "workflow.projectVisible",
            ),
          })}
        </span>
      </div>
      <Button size="sm" onClick={() => setPage("project", { projectId: link.projectId })}>
        {t("workflow.backToConsole")}
      </Button>
    </aside>
  );
}
