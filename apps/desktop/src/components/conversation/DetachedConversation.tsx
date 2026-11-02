import { useEffect, useState, type FormHTMLAttributes, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Textarea, TooltipButton } from "../ui";
import { IconArrowUp, IconSquare } from "../icons";
import { SessionPane } from "../SessionPane";
import { useAppStore } from "../../stores/app-store";
import type { SessionConfigurationInput } from "../../stores/app-state";
import { messageHasTranscriptContent } from "../../lib/chat-launch-error";
import { isRemoteSession, sessionAllows } from "../../lib/remote-session-safety";
import { ComposerModelPicker } from "../../features/chat/composer/ComposerModelPicker";
import { ComposerChatInstructionPicker } from "../../features/chat/composer/ComposerChatInstructionPicker";
import { useChatInstructionMenu } from "../../features/chat/composer/hooks/useChatInstructionMenu";
import { useTextareaMention } from "../../features/chat/mention/useTextareaMention";
import { useComposerModelMenu } from "../../features/chat/composer/hooks/useComposerModelMenu";
import { useSessionModelSelection } from "../../features/chat/composer/hooks/useSessionModelSelection";
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
  floating,
}: {
  /** Absent until the conversation exists (first send may create it). */
  sessionId?: string;
  draft: string;
  onDraftChange: (text: string) => void;
  /**
   * Resolves when the prompt was accepted; throws with a visible message
   * otherwise. `configuration` carries a model/effort chosen before the
   * conversation existed; the caller applies it to the created session
   * before its first prompt.
   */
  onSend: (text: string, configuration?: SessionConfigurationInput) => Promise<void>;
  emptyText: string;
  placeholder: string;
  inputLabel: string;
  sendLabel: string;
  scopeLabel?: string;
  /** When set, sending is unavailable and this explains why. */
  disabledReason?: string;
  formProps?: FormDataAttributes;
  /**
   * Controls that float over the top of the transcript (the return pill). The
   * transcript reserves room for them so the first message is never covered.
   */
  floating?: ReactNode;
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
  // Model/effort chosen before the conversation exists; applied on first send.
  const [pendingConfiguration, setPendingConfiguration] = useState<SessionConfigurationInput>();

  const projectPath = useAppStore(
    (state) =>
      state.sessions.find((item) => item.id === sessionId)?.projectPath ?? state.workspace?.path,
  );
  const mention = useTextareaMention({
    draft,
    onDraftChange,
    draftKey: sessionId ?? "",
    sessionId,
    projectPath,
  });

  useEffect(() => {
    if (sessionId && !attached) void attach(sessionId).catch(() => {});
  }, [attach, attached, sessionId]);

  async function send() {
    const text = draft.trim();
    if (!text || sending || disabledReason) return;
    setSending(true);
    setError(null);
    try {
      await onSend(mention.serialize(text), sessionId ? undefined : pendingConfiguration);
      onDraftChange("");
      setPendingConfiguration(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className={floating ? "detached-conversation has-floating" : "detached-conversation"}>
      <div className="detached-conversation-body">
        {floating}
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
        className={["composer-shell", "detached-conversation-composer", formProps?.className].filter(Boolean).join(" ")}
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        {mention.overlay}
        <Textarea
          ref={mention.textareaRef}
          className="detached-conversation-input"
          aria-label={inputLabel}
          placeholder={placeholder}
          rows={2}
          value={draft}
          onChange={mention.onChange}
          onSelect={mention.onSelect}
          onBlur={mention.onBlur}
          onCompositionStart={mention.onCompositionStart}
          onCompositionEnd={mention.onCompositionEnd}
          onKeyDown={(event) => {
            if (mention.handleKeyDown(event)) return;
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <div className="composer-toolbar">
          <div className="composer-left">
            {scopeLabel ? (
              <span className="composer-mode-chip-face text-sm detached-conversation-scope">{scopeLabel}</span>
            ) : null}
          </div>
          <div className="composer-right">
            <DetachedModelPicker
              sessionId={sessionId}
              pending={pendingConfiguration}
              onPendingChange={setPendingConfiguration}
              blocked={running}
            />
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
        </div>
      </form>
    </div>
  );
}

/**
 * The chat Composer's model × reasoning and chat-instruction pickers, bound
 * to one named session instead of the active one. Before the session exists
 * the choices are held as a pending configuration for the caller to apply on
 * creation.
 */
function DetachedModelPicker({
  sessionId,
  pending,
  onPendingChange,
  blocked,
}: {
  sessionId?: string;
  pending?: SessionConfigurationInput;
  onPendingChange: (configuration: SessionConfigurationInput) => void;
  blocked: boolean;
}) {
  const { t } = useTranslation();
  const session = useAppStore((state) => state.sessions.find((item) => item.id === sessionId));
  const configureSession = useAppStore((state) => state.configureSession);
  const mode = session?.mode ?? pending?.mode ?? "agent";
  const { provider, modelId, thinkingProvider, thinkingLevel, modelLabel } = useSessionModelSelection({
    session,
    draft: session ? undefined : pending,
    t,
  });
  const controlsBlocked = Boolean(session && !sessionAllows(session, "canConfigureModel"));
  const configureActiveSession = async (configuration: SessionConfigurationInput) => {
    if (sessionId) await configureSession(sessionId, configuration);
    else onPendingChange({ ...pending, ...configuration });
  };
  const controller = useComposerModelMenu({
    mode,
    activeSessionId: sessionId,
    provider,
    modelId,
    thinkingProvider,
    thinkingLevel,
    controlsBlocked,
    configureActiveSession,
  });
  // Detached surfaces can mount before any chat page has loaded the provider
  // catalog (e.g. the project console); load it once so the picker resolves.
  const providersLoaded = useAppStore((state) => state.providers.length > 0);
  const refreshProviders = useAppStore((state) => state.refreshProviders);
  useEffect(() => {
    if (!providersLoaded) void refreshProviders().catch(() => {});
  }, [providersLoaded, refreshProviders]);
  const instructionMenu = useChatInstructionMenu({
    remote: isRemoteSession(session),
    native: session?.source === "pi-native",
    apiStyle: provider?.apiStyle,
    session,
    draft: pending,
    mode,
    providerId: provider?.id,
    modelId,
    thinkingLevel,
    controlsBlocked,
    configureActiveSession,
  });
  return (
    <>
      <ComposerChatInstructionPicker
        t={t}
        controller={instructionMenu}
        controlsBlocked={controlsBlocked || (blocked && !sessionId)}
        onCloseOtherMenus={() => controller.setOpen(false)}
      />
      <ComposerModelPicker
        t={t}
        controller={controller}
        modelLabel={modelLabel}
        thinkingLabel={thinkingLevel}
        thinkingLevel={thinkingLevel}
        selectedProviderId={provider?.id}
        selectedModelId={modelId}
        controlsBlocked={controlsBlocked || (blocked && !sessionId)}
        onCloseOtherMenus={() => instructionMenu.setOpen(false)}
      />
    </>
  );
}
