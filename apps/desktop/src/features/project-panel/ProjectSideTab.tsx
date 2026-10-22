import { useTranslation } from "react-i18next";
import { Badge, Button, TooltipButton } from "../../components/ui";
import { IconChat } from "../../components/icons";
import { DetachedConversation } from "../../components/conversation/DetachedConversation";
import { useAppStore } from "../../stores/app-store";
import { useProjectAgentDraft } from "../project-workflow/project-agent-draft";
import { useProjectWorkflow } from "../project-workflow/useProjectWorkflow";
import { requestProjectContextView } from "./project-panel-actions";
import "./project-panel.css";

/**
 * A project side conversation as a work-panel tab. The header says what the
 * conversation is for and where its answers go (a side conversation is
 * read-only toward the workstream: its return policy is shown, never edited
 * here), then the transcript and composer read the session as a detached
 * conversation, so the Project Console stays the page.
 */
export function ProjectSideTab({ sessionId, label }: { sessionId: string; label?: string }) {
  const { t } = useTranslation();
  const { snapshot } = useProjectWorkflow();
  const side = snapshot?.conversations.find((item) => item.sessionId === sessionId);
  const workstream = side
    ? snapshot?.workstreams.find((item) => item.id === side.workstreamId)
    : undefined;
  const [draft, setDraft] = useProjectAgentDraft(`side:${sessionId}`);

  async function send(text: string) {
    const accepted = await useAppStore.getState().sendPrompt(text, { text, fileReferences: [] }, sessionId);
    if (!accepted) throw new Error(t("workflow.agentSendFailed"));
  }

  return (
    <section
      className="project-side-tab"
      aria-label={label || t("projectPanel.sideTab")}
      data-project-side-tab={sessionId}
    >
      <div className="project-panel-context" data-project-side-context={sessionId}>
        {side ? <Badge>{t(`workflow.purposes.${side.purpose}`)}</Badge> : null}
        {side ? (
          <span data-project-side-policy={side.returnPolicy}>
            <Badge>{t(`projectStructure.returnPolicies.${side.returnPolicy}`)}</Badge>
          </span>
        ) : null}
        <span className="project-panel-context-text">
          {workstream ? t("workflow.sideFrom", { workstream: workstream.title }) : null}
        </span>
        {side?.purpose === "explore" ? (
          <Button
            variant="ghost"
            size="sm"
            data-project-side-review
            onClick={() => requestProjectContextView(side.projectId, side.workstreamId)}
          >
            {t("workflow.reviewProposals")}
          </Button>
        ) : null}
        <TooltipButton
          className="ct-icon-btn"
          tooltip={t("projectStructure.openSession")}
          ariaLabel={t("projectStructure.openSession")}
          data-project-side-open
          onClick={() => void useAppStore.getState().selectSession(sessionId)}
        >
          <IconChat size={14} />
        </TooltipButton>
      </div>
      <DetachedConversation
        key={sessionId}
        sessionId={sessionId}
        draft={draft}
        onDraftChange={setDraft}
        onSend={send}
        emptyText={t("workflow.sideEmpty")}
        placeholder={t("workflow.sidePlaceholder")}
        inputLabel={t("workflow.sidePlaceholder")}
        sendLabel={t("workflow.sendAgent")}
        scopeLabel={workstream?.title}
        formProps={{ "data-workflow": "side-intent" }}
      />
    </section>
  );
}
