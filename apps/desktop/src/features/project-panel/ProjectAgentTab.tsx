import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectGroupRecord } from "@pi-desktop/shared";
import { Button } from "../../components/ui";
import { DetachedConversation } from "../../components/conversation/DetachedConversation";
import { applyPendingConfiguration } from "../../components/conversation/pending-configuration";
import { useAppStore } from "../../stores/app-store";
import type { SessionConfigurationInput } from "../../stores/app-state";
import { normalizeProjectPath } from "../../lib/sidebar-session-groups";
import { ProjectAgentButton } from "../project-workflow/ProjectAgentButton";
import { useProjectAgentDraft } from "../project-workflow/project-agent-draft";
import { useProjectWorkflow } from "../project-workflow/useProjectWorkflow";
import { useWorkflowProjectGroups } from "../project-workflow/WorkflowNavigation";
import { BringInDialog } from "./BringInDialog";
import { SendToConversationDialog } from "./SendToConversationDialog";
import { listConversationTargets } from "./project-panel-text";
import "./project-panel.css";

/**
 * Whether a session's project path lies in one of the project's roots. A
 * path inside a root counts as well as the root itself.
 */
export function projectPathPredicate(group: ProjectGroupRecord | undefined) {
  const roots = (group?.roots ?? []).map((root) => normalizeProjectPath(root.path)).filter(Boolean) as string[];
  return (projectPath: string | undefined) => {
    const path = normalizeProjectPath(projectPath);
    return Boolean(path) && roots.some((root) => path === root || path!.startsWith(`${root}/`));
  };
}

/**
 * The project's discussion-only Agent as a work-panel tab (ADR
 * project-structure-views, amended). The tab reads the canonical Agent session
 * as a detached transcript, so the page underneath stays where it is. The
 * first send creates the session through the same `agent.open` action the
 * toolbar entry uses.
 *
 * The Agent has no tools: handing a thread something, or reading a thread, is
 * done here by the user through the two dialogs, never by the Agent.
 */
export function ProjectAgentTab({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const { snapshot, action } = useProjectWorkflow();
  const sessions = useAppStore((state) => state.sessions);
  const { groups } = useWorkflowProjectGroups(projectId);
  const group = groups.find((item) => item.id === projectId);
  const agentSessionId = snapshot?.projectAgents?.find((agent) => agent.projectId === projectId)
    ?.sessionId;
  const [draft, setDraft] = useProjectAgentDraft(projectId);
  const [dialog, setDialog] = useState<"send" | "bring" | null>(null);
  const inProject = useMemo(() => projectPathPredicate(group), [group]);
  const untitled = t("projectPanel.untitled");
  const targets = useMemo(
    () => listConversationTargets({ snapshot, projectId, sessions, inProject, untitled }),
    [inProject, projectId, sessions, snapshot, untitled],
  );

  async function sendToAgent(text: string, configuration?: SessionConfigurationInput) {
    let target = agentSessionId;
    if (!target) {
      target = (await action({ kind: "agent.open", projectId }))?.sessionId;
      if (!target) throw new Error(t("workflow.agentOpenFailed"));
      await useAppStore.getState().refreshSessions();
    }
    await applyPendingConfiguration(target, configuration);
    // The transcript view is a convenience; a failed read must not block the send.
    await useAppStore.getState().attachSessionTranscript(target).catch(() => {});
    const accepted = await useAppStore.getState().sendPrompt(text, { text, fileReferences: [] }, target);
    if (!accepted) throw new Error(t("workflow.agentSendFailed"));
  }

  return (
    <section
      className="project-agent-tab"
      aria-label={t("workflow.agentTitle")}
      data-project-agent-dock={projectId}
    >
      <div className="project-panel-context">
        <span className="project-panel-context-text">{t("workflow.agentDiscussionHint")}</span>
        <ProjectAgentButton projectId={projectId} className="ct-icon-btn" />
      </div>
      <div className="project-panel-actions">
        <Button variant="ghost" size="sm" onClick={() => setDialog("send")} data-project-send-open>
          {t("projectPanel.sendOpen")}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setDialog("bring")} data-project-bring-open>
          {t("projectPanel.bringOpen")}
        </Button>
      </div>
      <DetachedConversation
        key={projectId}
        sessionId={agentSessionId}
        draft={draft}
        onDraftChange={setDraft}
        onSend={sendToAgent}
        emptyText={t("workflow.agentDockEmpty")}
        placeholder={t("workflow.agentPlaceholder")}
        inputLabel={t("workflow.intentText")}
        sendLabel={t("workflow.sendAgent")}
        scopeLabel={group?.name}
        // `agent.open` needs the loaded snapshot's revision; until then a send could only fail.
        disabledReason={snapshot ? undefined : t("workflow.loading")}
        formProps={{ "data-workflow": "project-intent" }}
      />
      {dialog === "send" ? (
        <SendToConversationDialog
          agentSessionId={agentSessionId}
          targets={targets}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === "bring" ? (
        <BringInDialog
          targets={targets}
          onInsert={(text) => setDraft(draft.trim() ? `${draft.replace(/\s+$/, "")}\n\n${text}` : text)}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </section>
  );
}
