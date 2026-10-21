import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Textarea, TooltipButton } from "../../components/ui";
import { IconArrowUp, IconChat, IconClose } from "../../components/icons";
import { SessionPane } from "../../components/SessionPane";
import { useAppStore } from "../../stores/app-store";
import { messageHasTranscriptContent } from "../../lib/chat-launch-error";
import { ProjectAgentButton } from "./ProjectAgentButton";
import { useProjectAgentDraft } from "./project-agent-draft";
import { useProjectWorkflow } from "./useProjectWorkflow";

/**
 * The project's discussion-only Agent beside the Project Console.
 *
 * The dock reads the canonical Agent session as a detached transcript, so the
 * console stays the visible page and the chat surface keeps its own panes.
 * Prompts go through the shared send path with an explicit session target;
 * the full conversation stays one click away through the existing entry.
 */
export function ProjectAgentDock({
  projectId,
  projectName,
  onClose,
}: {
  projectId: string;
  projectName?: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { snapshot, action } = useProjectWorkflow();
  const sessionId = snapshot?.projectAgents?.find((agent) => agent.projectId === projectId)
    ?.sessionId;
  const attach = useAppStore((state) => state.attachSessionTranscript);
  const attached = useAppStore((state) =>
    sessionId
      ? state.activeSessionId === sessionId || Boolean(state.retainedTranscripts[sessionId])
      : false,
  );
  const hasContent = useAppStore((state) => {
    if (!sessionId) return false;
    const messages =
      state.activeSessionId === sessionId ? state.messages : state.retainedTranscripts[sessionId];
    return Boolean(messages?.some((message) => messageHasTranscriptContent(message)));
  });
  const [intent, setIntent] = useProjectAgentDraft(projectId);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (sessionId && !attached) void attach(sessionId).catch(() => {});
  }, [attach, attached, sessionId]);

  async function send() {
    const text = intent.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    try {
      let target = sessionId;
      if (!target) {
        target = (await action({ kind: "agent.open", projectId }))?.sessionId;
        if (!target) throw new Error(t("workflow.agentOpenFailed"));
        await useAppStore.getState().refreshSessions();
      }
      // The transcript view is a convenience; a failed read must not block the send.
      await attach(target).catch(() => {});
      const accepted = await useAppStore
        .getState()
        .sendPrompt(text, { text, fileReferences: [] }, target);
      if (!accepted) throw new Error(t("workflow.agentSendFailed"));
      setIntent("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  }

  return (
    <aside
      className="project-agent-dock"
      aria-label={t("workflow.agentTitle")}
      data-project-agent-dock={projectId}
    >
      <header className="project-agent-dock-header">
        <span className="project-agent-dock-glyph" aria-hidden="true">
          <IconChat size={15} />
        </span>
        <h2>{t("workflow.agentTitle")}</h2>
        <span className="project-agent-dock-tag">{t("workflow.agentDiscussionTag")}</span>
        <span className="project-agent-dock-spacer" />
        <ProjectAgentButton projectId={projectId} className="ct-icon-btn" />
        <TooltipButton
          className="ct-icon-btn"
          tooltip={t("workflow.agentDockClose")}
          ariaLabel={t("workflow.agentDockClose")}
          onClick={onClose}
        >
          <IconClose size={15} />
        </TooltipButton>
      </header>
      <div className="project-agent-dock-body">
        {sessionId && attached ? (
          <SessionPane sessionId={sessionId} visible />
        ) : null}
        {!hasContent ? (
          <p className="project-agent-dock-empty">{t("workflow.agentDockEmpty")}</p>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="workflow-error project-agent-dock-error">
          {error}
        </p>
      ) : null}
      <form
        className="project-agent-dock-composer"
        data-workflow="project-intent"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <Textarea
          aria-label={t("workflow.intentText")}
          placeholder={t("workflow.agentPlaceholder")}
          rows={2}
          value={intent}
          onChange={(event) => setIntent(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <div className="project-agent-dock-toolbar">
          <span className="project-agent-dock-scope">{projectName}</span>
          <TooltipButton
            type="submit"
            className="send-btn"
            tooltip={t("workflow.sendAgent")}
            ariaLabel={t("workflow.sendAgent")}
            disabled={sending || !intent.trim()}
          >
            <IconArrowUp size={16} />
          </TooltipButton>
        </div>
      </form>
    </aside>
  );
}
