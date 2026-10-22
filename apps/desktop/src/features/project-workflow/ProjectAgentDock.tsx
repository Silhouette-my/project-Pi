import { useTranslation } from "react-i18next";
import type { HTMLAttributes } from "react";
import { Badge, Button, TooltipButton } from "../../components/ui";
import { IconChat, IconClose, IconPin } from "../../components/icons";
import { DetachedConversation } from "../../components/conversation/DetachedConversation";
import { useAppStore } from "../../stores/app-store";
import { ProjectAgentButton } from "./ProjectAgentButton";
import { useProjectAgentDraft } from "./project-agent-draft";
import { useProjectWorkflow } from "./useProjectWorkflow";

export const AGENT_TAB = "agent";

type EdgePanelProps = HTMLAttributes<HTMLElement> & { ref?: React.Ref<HTMLElement> };

/**
 * The project's right panel: the discussion-only Agent plus the workstream
 * side conversations the user opened here (PRODUCT P6). Every tab reads its
 * session as a detached transcript, so the Project Console stays the visible
 * page; each tab still opens as a full conversation on request.
 */
export function ProjectAgentDock({
  projectId,
  projectName,
  sideSessionIds,
  activeTab,
  onSelectTab,
  onCloseSide,
  onClose,
  onOpenContext,
  pinned,
  onTogglePin,
  edgePanel,
}: {
  projectId: string;
  projectName?: string;
  sideSessionIds: string[];
  activeTab: string;
  onSelectTab: (tab: string) => void;
  onCloseSide: (sessionId: string) => void;
  onClose: () => void;
  onOpenContext: (workstreamId?: string) => void;
  pinned: boolean;
  onTogglePin: () => void;
  edgePanel?: EdgePanelProps;
}) {
  const { t } = useTranslation();
  const { snapshot, action } = useProjectWorkflow();
  const sessions = useAppStore((state) => state.sessions);
  const agentSessionId = snapshot?.projectAgents?.find((agent) => agent.projectId === projectId)
    ?.sessionId;
  const [agentDraft, setAgentDraft] = useProjectAgentDraft(projectId);
  const [sideDraft, setSideDraft] = useProjectAgentDraft(`side:${activeTab}`);
  const side = activeTab === AGENT_TAB
    ? undefined
    : snapshot?.conversations.find((item) => item.sessionId === activeTab);
  const sideWork = side ? snapshot?.workstreams.find((item) => item.id === side.workstreamId) : undefined;
  const titleOf = (id: string) => sessions.find((session) => session.id === id)?.title?.trim();
  const purposeOf = (id: string) => snapshot?.conversations.find((item) => item.sessionId === id)?.purpose;
  const { className: edgeClassName, ...edgeRest } = edgePanel ?? {};

  async function sendToAgent(text: string) {
    let target = agentSessionId;
    if (!target) {
      target = (await action({ kind: "agent.open", projectId }))?.sessionId;
      if (!target) throw new Error(t("workflow.agentOpenFailed"));
      await useAppStore.getState().refreshSessions();
    }
    // The transcript view is a convenience; a failed read must not block the send.
    await useAppStore.getState().attachSessionTranscript(target).catch(() => {});
    const accepted = await useAppStore.getState().sendPrompt(text, { text, fileReferences: [] }, target);
    if (!accepted) throw new Error(t("workflow.agentSendFailed"));
  }
  async function sendToSide(sessionId: string, text: string) {
    const accepted = await useAppStore.getState().sendPrompt(text, { text, fileReferences: [] }, sessionId);
    if (!accepted) throw new Error(t("workflow.agentSendFailed"));
  }

  return (
    <aside
      {...edgeRest}
      className={["project-agent-dock", edgeClassName].filter(Boolean).join(" ")}
      aria-label={t("workflow.agentTitle")}
      data-project-agent-dock={projectId}
    >
      <header className="project-agent-dock-header">
        {sideSessionIds.length ? (
          <div className="project-agent-dock-tabs" role="tablist" aria-label={t("workflow.dockTabs")}>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === AGENT_TAB}
              className="project-agent-dock-tab"
              onClick={() => onSelectTab(AGENT_TAB)}
            >
              <IconChat size={13} />
              <span>{t("workflow.agentTabShort")}</span>
            </button>
            {sideSessionIds.map((id) => (
              <span key={id} className="project-agent-dock-tab-wrap" data-project-side-tab={id}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === id}
                  className="project-agent-dock-tab"
                  title={titleOf(id)}
                  onClick={() => onSelectTab(id)}
                >
                  <span>{titleOf(id) || t(`workflow.purposes.${purposeOf(id) ?? "ask"}`)}</span>
                </button>
                <TooltipButton
                  className="project-agent-dock-tab-close"
                  tooltip={t("workflow.closeSideTab")}
                  ariaLabel={t("workflow.closeSideTab")}
                  onClick={() => onCloseSide(id)}
                >
                  <IconClose size={12} />
                </TooltipButton>
              </span>
            ))}
          </div>
        ) : (
          <>
            <span className="project-agent-dock-glyph" aria-hidden="true">
              <IconChat size={15} />
            </span>
            <h2>{t("workflow.agentTitle")}</h2>
            <span className="project-agent-dock-tag">{t("workflow.agentDiscussionTag")}</span>
          </>
        )}
        <span className="project-agent-dock-spacer" />
        <TooltipButton
          className="ct-icon-btn edge-pin-btn"
          tooltip={t(pinned ? "nav.unpinWorkPanel" : "nav.pinWorkPanel")}
          ariaLabel={t(pinned ? "nav.unpinWorkPanel" : "nav.pinWorkPanel")}
          aria-pressed={pinned}
          onClick={onTogglePin}
        >
          <IconPin size={14} />
        </TooltipButton>
        <TooltipButton
          className="ct-icon-btn"
          tooltip={t("workflow.agentDockClose")}
          ariaLabel={t("workflow.agentDockClose")}
          onClick={onClose}
        >
          <IconClose size={15} />
        </TooltipButton>
      </header>
      {activeTab === AGENT_TAB ? (
        <>
          <div className="project-agent-dock-context">
            <span>{t("workflow.agentDiscussionHint")}</span>
            <ProjectAgentButton projectId={projectId} className="ct-icon-btn" />
          </div>
          <DetachedConversation
            key={AGENT_TAB}
            sessionId={agentSessionId}
            draft={agentDraft}
            onDraftChange={setAgentDraft}
            onSend={sendToAgent}
            emptyText={t("workflow.agentDockEmpty")}
            placeholder={t("workflow.agentPlaceholder")}
            inputLabel={t("workflow.intentText")}
            sendLabel={t("workflow.sendAgent")}
            scopeLabel={projectName}
            formProps={{ "data-workflow": "project-intent" }}
          />
        </>
      ) : (
        <>
          <div className="project-agent-dock-context" data-project-side-context={activeTab}>
            {side ? <Badge>{t(`workflow.purposes.${side.purpose}`)}</Badge> : null}
            <span className="project-agent-dock-context-text">
              {sideWork ? t("workflow.sideFrom", { workstream: sideWork.title }) : null}
            </span>
            {side?.purpose === "explore" ? (
              <Button variant="ghost" onClick={() => onOpenContext(side.workstreamId)}>
                {t("workflow.reviewProposals")}
              </Button>
            ) : null}
            <TooltipButton
              className="ct-icon-btn"
              tooltip={t("projectStructure.openSession")}
              ariaLabel={t("projectStructure.openSession")}
              onClick={() => void useAppStore.getState().selectSession(activeTab)}
            >
              <IconChat size={14} />
            </TooltipButton>
          </div>
          <DetachedConversation
            key={activeTab}
            sessionId={activeTab}
            draft={sideDraft}
            onDraftChange={setSideDraft}
            onSend={(text) => sendToSide(activeTab, text)}
            emptyText={t("workflow.sideEmpty")}
            placeholder={t("workflow.sidePlaceholder")}
            inputLabel={t("workflow.sidePlaceholder")}
            sendLabel={t("workflow.sendAgent")}
            scopeLabel={sideWork?.title}
            formProps={{ "data-workflow": "side-intent" }}
          />
        </>
      )}
    </aside>
  );
}
