import { useState } from "react";
import { useTranslation } from "react-i18next";
import { TooltipButton } from "../../components/ui";
import { IconChat } from "../../components/icons";
import { DetachedConversation } from "../../components/conversation/DetachedConversation";
import { FloatingReturnBar } from "../../components/workpanel/FloatingReturnBar";
import { useAppStore } from "../../stores/app-store";
import { useProjectAgentDraft } from "../project-workflow/project-agent-draft";
import { useProjectWorkflow } from "../project-workflow/useProjectWorkflow";
import {
  SIDE_RETURN_POLICIES,
  sideReturnBlockReason,
  sideReturnContent,
  type SideReturnPolicy,
} from "./project-return-core";
import { useSessionMessages } from "./use-session-messages";
import "./project-panel.css";

/**
 * A project side conversation as a work-panel tab. A floating pill names where
 * its answers go (none / proposal / delivery, the Host's return policy) and
 * changes it at any time; "Return to conversation" records the newest answer as
 * a proposal in the project's Context tab or as an output of the workstream,
 * as the policy says. The transcript and composer read the session as a
 * detached conversation, so the Project Console stays the page.
 */
export function ProjectSideTab({ sessionId, label }: { sessionId: string; label?: string }) {
  const { t } = useTranslation();
  const { snapshot, mutate } = useProjectWorkflow();
  const side = snapshot?.conversations.find((item) => item.sessionId === sessionId);
  const workstream = side
    ? snapshot?.workstreams.find((item) => item.id === side.workstreamId)
    : undefined;
  const [draft, setDraft] = useProjectAgentDraft(`side:${sessionId}`);
  const messages = useSessionMessages(sessionId);
  const running = useAppStore((state) => state.runningSessions[sessionId] === true);
  const [returning, setReturning] = useState(false);
  const policy: SideReturnPolicy = side?.returnPolicy ?? "none";
  const content = sideReturnContent(messages);
  const blocked = sideReturnBlockReason({ running, hasAnswer: Boolean(content) });

  async function send(text: string) {
    const accepted = await useAppStore.getState().sendPrompt(text, { text, fileReferences: [] }, sessionId);
    if (!accepted) throw new Error(t("workflow.agentSendFailed"));
  }

  async function setPolicy(next: string) {
    if (!side || next === policy) return;
    const result = await mutate({
      kind: "conversation.policy",
      projectId: side.projectId,
      workstreamId: side.workstreamId,
      sessionId,
      returnPolicy: next as SideReturnPolicy,
    });
    if (!result) {
      useAppStore.getState().showToast(t("workPanel.return.failed"), { variant: "error" });
    }
  }

  async function returnToConversation() {
    if (!side || !content || blocked || returning || policy === "none") return;
    setReturning(true);
    try {
      const result = await mutate({
        kind: "conversation.return",
        projectId: side.projectId,
        workstreamId: side.workstreamId,
        sessionId,
        recordId: crypto.randomUUID(),
        title: content.title,
        text: content.text,
        createdAt: new Date().toISOString(),
      });
      useAppStore.getState().showToast(
        result
          ? t(policy === "proposal" ? "workPanel.return.proposed" : "workPanel.return.delivered")
          : t("workPanel.return.failed"),
        { variant: result ? "success" : "error" },
      );
    } finally {
      setReturning(false);
    }
  }

  return (
    <section
      className="project-side-tab"
      aria-label={label || t("projectPanel.sideTab")}
      data-project-side-tab={sessionId}
      data-project-side-policy={policy}
    >
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
        floating={
          <FloatingReturnBar
            workflow="project-side"
            label={t("workPanel.return.pill", { mode: t(`workPanel.return.modes.${policy}`) })}
            menuLabel={t("workPanel.return.menuLabel")}
            sections={[
              {
                id: "mode",
                options: SIDE_RETURN_POLICIES.map((value) => ({
                  id: value,
                  label: t(`workPanel.return.modes.${value}`),
                  checked: value === policy,
                  disabled: !side,
                })),
                onSelect: (value) => void setPolicy(value),
              },
            ]}
            actionLabel={t("workPanel.return.action")}
            showAction={policy !== "none"}
            actionDisabled={Boolean(blocked) || returning}
            actionBusy={returning}
            actionTitle={blocked ? t(blocked) : undefined}
            onAction={() => void returnToConversation()}
            trailing={
              <TooltipButton
                className="ct-icon-btn"
                tooltip={t("projectStructure.openSession")}
                ariaLabel={t("projectStructure.openSession")}
                data-project-side-open
                onClick={() => void useAppStore.getState().selectSession(sessionId)}
              >
                <IconChat size={14} />
              </TooltipButton>
            }
          />
        }
      />
    </section>
  );
}
