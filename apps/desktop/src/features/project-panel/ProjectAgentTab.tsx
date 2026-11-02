import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectGroupRecord } from "@pi-desktop/shared";
import { DetachedConversation } from "../../components/conversation/DetachedConversation";
import { applyPendingConfiguration } from "../../components/conversation/pending-configuration";
import { FloatingReturnBar } from "../../components/workpanel/FloatingReturnBar";
import { useAppStore } from "../../stores/app-store";
import type { SessionConfigurationInput } from "../../stores/app-state";
import { normalizeProjectPath } from "../../lib/sidebar-session-groups";
import { TooltipButton } from "../../components/ui";
import { IconNewSession } from "../../components/icons";
import { useProjectAgentDraft } from "../project-workflow/project-agent-draft";
import { useProjectAgent } from "../project-workflow/useProjectAgent";
import { useProjectWorkflow } from "../project-workflow/useProjectWorkflow";
import { useWorkflowProjectGroups } from "../project-workflow/WorkflowNavigation";
import { listConversationTargets } from "./project-panel-text";
import {
  agentHasAnswer,
  returnAgentToTarget,
  setAgentReturnMode,
  setAgentReturnTarget,
  useAgentReturnState,
  useLastProjectConversation,
} from "./project-agent-return";
import {
  AGENT_RETURN_MODES,
  agentReturnBlockReason,
  agentReturnPillLabel,
  resolveReturnTarget,
} from "./project-return-core";
import { useSessionMessages } from "./use-session-messages";
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
 * The Agent has no tools: handing its discussion to a thread is done by the
 * user through the floating return control (a quote into the target's draft,
 * never a send); reading a thread into the Agent is an @-mention in the
 * composer.
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
  const inProject = useMemo(() => projectPathPredicate(group), [group]);
  const untitled = t("projectPanel.untitled");
  const targets = useMemo(
    () => listConversationTargets({ snapshot, projectId, sessions, inProject, untitled }),
    [inProject, projectId, sessions, snapshot, untitled],
  );
  const agent = useProjectAgent(projectId);
  const returnState = useAgentReturnState(projectId);
  const lastConversationId = useLastProjectConversation(projectId);
  const target = resolveReturnTarget(targets, returnState.targetId, lastConversationId);
  const messages = useSessionMessages(agentSessionId);
  const running = useAppStore((state) =>
    agentSessionId ? state.runningSessions[agentSessionId] === true : false,
  );
  const mode = returnState.mode;
  const blocked = agentReturnBlockReason({
    hasTarget: Boolean(target),
    running,
    hasAnswer: agentHasAnswer(messages),
  });
  const modeLabel = t(`workPanel.return.modes.${mode}`);
  const pill = agentReturnPillLabel(modeLabel, mode, target?.title, {
    pill: (value) => t("workPanel.return.pill", { mode: value }),
    pillTarget: (value, title) => t("workPanel.return.pillTarget", { mode: value, target: title }),
  });

  async function sendToAgent(text: string, configuration?: SessionConfigurationInput) {
    let sessionId = agentSessionId;
    if (!sessionId) {
      sessionId = (await action({ kind: "agent.open", projectId }))?.sessionId;
      if (!sessionId) throw new Error(t("workflow.agentOpenFailed"));
      await useAppStore.getState().refreshSessions();
    }
    await applyPendingConfiguration(sessionId, configuration);
    // The transcript view is a convenience; a failed read must not block the send.
    await useAppStore.getState().attachSessionTranscript(sessionId).catch(() => {});
    const accepted = await useAppStore.getState().sendPrompt(text, { text, fileReferences: [] }, sessionId);
    if (!accepted) throw new Error(t("workflow.agentSendFailed"));
  }

  return (
    <section
      className="project-agent-tab"
      aria-label={t("workflow.agentTitle")}
      data-project-agent-dock={projectId}
    >
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
        // `agent.open` needs the loaded snapshot's revision; until then a send could only fail.
        disabledReason={snapshot ? undefined : t("workflow.loading")}
        formProps={{ "data-workflow": "project-intent" }}
        floating={
          <FloatingReturnBar
            workflow="project-agent"
            label={pill}
            menuLabel={t("workPanel.return.menuLabel")}
            sections={[
              {
                id: "mode",
                heading: t("workPanel.return.modeHeading"),
                options: AGENT_RETURN_MODES.map((value) => ({
                  id: value,
                  label: t(`workPanel.return.modes.${value}`),
                  checked: value === mode,
                })),
                onSelect: (value) => setAgentReturnMode(projectId, value as typeof mode),
              },
              {
                id: "target",
                heading: t("workPanel.return.targetHeading"),
                options: targets.map((item) => ({
                  id: item.sessionId,
                  label: item.title,
                  checked: item.sessionId === target?.sessionId,
                })),
                onSelect: (value) => setAgentReturnTarget(projectId, value),
              },
            ]}
            actionLabel={t("workPanel.return.action")}
            showAction={mode !== "none"}
            actionDisabled={Boolean(blocked) || returnState.status === "running" || !agentSessionId}
            actionBusy={returnState.status === "running"}
            actionTitle={
              returnState.status === "running"
                ? t("sideChat.returning")
                : blocked
                  ? t(blocked)
                  : undefined
            }
            trailing={
              <TooltipButton
                type="button"
                className="ct-icon-btn"
                tooltip={agent.error ?? t("sideChat.openAsSession")}
                ariaLabel={t("sideChat.openAsSession")}
                data-project-agent={projectId}
                aria-busy={agent.busy}
                disabled={agent.busy}
                onClick={() => void agent.open().catch(() => {})}
              >
                <IconNewSession size={14} />
              </TooltipButton>
            }
            onAction={() => {
              if (!target || !agentSessionId || blocked) return;
              void returnAgentToTarget({
                projectId,
                projectName: group?.name ?? "",
                agentSessionId,
                mode,
                target,
              });
            }}
          />
        }
      />
    </section>
  );
}
