import { useEffect, useState, type FormHTMLAttributes } from "react";
import { useTranslation } from "react-i18next";
import { Textarea, TooltipButton } from "../ui";
import { IconArrowUp, IconSquare } from "../icons";
import { SessionPane } from "../SessionPane";
import { useAppStore } from "../../stores/app-store";
import { messageHasTranscriptContent } from "../../lib/chat-launch-error";
import "./detached-conversation.css";

type FormDataAttributes = Pick<FormHTMLAttributes<HTMLFormElement>, "className"> & {
  [key: `data-${string}`]: string | undefined;
};

/**
 * A live conversation shown outside the chat surface (project Agent dock,
 * project side conversations, chat side chats).
 *
 * The session is read as a detached transcript (ADR project-structure-views):
 * it never becomes the active session, the visible page does not change, and
 * the chat surface mounts no extra pane. Sending always names its target
 * session through the caller; nothing here can inherit an unrelated chat.
 */
export function DetachedConversation({
  sessionId,
  draft,
  onDraftChange,
  onSend,
  emptyText,
  placeholder,
  inputLabel,
  sendLabel,
  scopeLabel,
  disabledReason,
  formProps,
}: {
  /** Absent until the conversation exists (first send may create it). */
  sessionId?: string;
  draft: string;
  onDraftChange: (text: string) => void;
  /** Resolves when the prompt was accepted; throws with a visible message otherwise. */
  onSend: (text: string) => Promise<void>;
  emptyText: string;
  placeholder: string;
  inputLabel: string;
  sendLabel: string;
  scopeLabel?: string;
  /** When set, sending is unavailable and this explains why. */
  disabledReason?: string;
  formProps?: FormDataAttributes;
}) {
  const { t } = useTranslation();
  const attach = useAppStore((state) => state.attachSessionTranscript);
  const abortSession = useAppStore((state) => state.abortSession);
  const attached = useAppStore((state) =>
    sessionId
      ? state.activeSessionId === sessionId || Boolean(state.retainedTranscripts[sessionId])
      : false,
  );
  const running = useAppStore((state) =>
    sessionId ? state.runningSessions[sessionId] === true : false,
  );
  const hasContent = useAppStore((state) => {
    if (!sessionId) return false;
    const messages =
      state.activeSessionId === sessionId ? state.messages : state.retainedTranscripts[sessionId];
    return Boolean(messages?.some((message) => messageHasTranscriptContent(message)));
  });
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (sessionId && !attached) void attach(sessionId).catch(() => {});
  }, [attach, attached, sessionId]);

  async function send() {
    const text = draft.trim();
    if (!text || sending || disabledReason) return;
    setSending(true);
    setError(null);
    try {
      await onSend(text);
      onDraftChange("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="detached-conversation">
      <div className="detached-conversation-body">
        {sessionId && attached ? <SessionPane sessionId={sessionId} visible /> : null}
        {!hasContent ? <p className="detached-conversation-empty">{emptyText}</p> : null}
      </div>
      {error || disabledReason ? (
        <p role={error ? "alert" : "status"} className="detached-conversation-notice">
          {error ?? disabledReason}
        </p>
      ) : null}
      <form
        {...formProps}
        className={["detached-conversation-composer", formProps?.className].filter(Boolean).join(" ")}
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <Textarea
          aria-label={inputLabel}
          placeholder={placeholder}
          rows={2}
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <div className="detached-conversation-toolbar">
          <span className="detached-conversation-scope">{scopeLabel}</span>
          {running && sessionId ? (
            <TooltipButton
              type="button"
              className="send-btn"
              tooltip={t("chat.stopGenerating")}
              ariaLabel={t("chat.stopGenerating")}
              onClick={() => void abortSession(sessionId)}
            >
              <IconSquare size={12} />
            </TooltipButton>
          ) : (
            <TooltipButton
              type="submit"
              className="send-btn"
              tooltip={sendLabel}
              ariaLabel={sendLabel}
              disabled={sending || !draft.trim() || Boolean(disabledReason)}
            >
              <IconArrowUp size={16} />
            </TooltipButton>
          )}
        </div>
      </form>
    </div>
  );
}
